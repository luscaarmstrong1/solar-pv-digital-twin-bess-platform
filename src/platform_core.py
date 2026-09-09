from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd
import pvlib
import yaml
from PIL import Image, ImageDraw
from scipy.optimize import brentq, linprog
from sklearn.ensemble import IsolationForest
from sklearn.metrics import f1_score, precision_score, recall_score

from src.models import BESS, PVModule, PVPlant

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RESULTS = DATA / "portfolio" / "results.json"


def plant() -> PVPlant:
    return PVPlant()


def module() -> PVModule:
    return PVModule()


def daylight_hours(index: pd.DatetimeIndex) -> pd.Series:
    p = plant()
    loc = pvlib.location.Location(p.latitude, p.longitude, p.timezone, p.altitude_m)
    solpos = loc.get_solarposition(index)
    return (solpos["apparent_elevation"] > 0).astype(float)


def generate_weather(start: str = "2024-01-01", end: str = "2025-12-31 23:00") -> pd.DataFrame:
    p = plant()
    idx = pd.date_range(start, end, freq="h", tz=p.timezone)
    loc = pvlib.location.Location(p.latitude, p.longitude, p.timezone, p.altitude_m)
    solpos = loc.get_solarposition(idx)
    clearsky = loc.get_clearsky(idx, model="ineichen")
    rng = np.random.default_rng(42)
    day_of_year = idx.dayofyear.to_numpy()
    hour = idx.hour.to_numpy()
    seasonal = 0.82 + 0.12 * np.cos(2 * np.pi * (day_of_year - 30) / 365.25)
    synoptic = 0.12 * np.sin(np.arange(len(idx)) / 71.0) + 0.08 * np.sin(np.arange(len(idx)) / 19.0)
    cloud = np.clip(seasonal + synoptic + rng.normal(0, 0.06, len(idx)), 0.35, 1.05)
    night = solpos["apparent_elevation"].to_numpy() <= 0
    ghi = clearsky["ghi"].to_numpy() * cloud
    dni = clearsky["dni"].to_numpy() * np.clip(cloud + 0.05, 0, 1.05) ** 1.35
    cosz = np.cos(np.radians(solpos["zenith"].to_numpy()))
    dhi = np.maximum(ghi - dni * np.maximum(cosz, 0), 0)
    ghi[night] = 0
    dni[night] = 0
    dhi[night] = 0
    temp_air = 23 + 5 * np.sin(2 * np.pi * (hour - 7) / 24) + 4 * np.sin(2 * np.pi * (day_of_year - 20) / 365.25)
    wind = np.clip(2.4 + 0.8 * np.sin(2 * np.pi * hour / 24) + rng.normal(0, 0.45, len(idx)), 0.2, 7.0)
    humidity = np.clip(68 - 0.35 * (temp_air - 22) + rng.normal(0, 5, len(idx)), 25, 98)
    cloud_cover = np.clip((1 - cloud) * 100 + rng.normal(0, 4, len(idx)), 0, 100)
    df = pd.DataFrame(
        {
            "timestamp": idx,
            "ghi_w_m2": ghi,
            "dni_w_m2": dni,
            "dhi_w_m2": dhi,
            "temp_air_c": temp_air,
            "wind_speed_m_s": wind,
            "relative_humidity_pct": humidity,
            "cloud_cover_pct": cloud_cover,
            "solar_zenith_deg": solpos["zenith"].to_numpy(),
            "solar_azimuth_deg": solpos["azimuth"].to_numpy(),
            "solar_elevation_deg": solpos["apparent_elevation"].to_numpy(),
        }
    )
    return df


def calculate_poa(weather: pd.DataFrame) -> pd.DataFrame:
    p = plant()
    times = pd.DatetimeIndex(weather["timestamp"])
    dni_extra = pvlib.irradiance.get_extra_radiation(times).to_numpy()
    zenith = weather["solar_zenith_deg"].to_numpy(dtype=float)
    azimuth = weather["solar_azimuth_deg"].to_numpy(dtype=float)
    dni = weather["dni_w_m2"].to_numpy(dtype=float)
    ghi = weather["ghi_w_m2"].to_numpy(dtype=float)
    dhi = weather["dhi_w_m2"].to_numpy(dtype=float)
    airmass = np.asarray(pvlib.atmosphere.get_relative_airmass(zenith), dtype=float)
    poa = pvlib.irradiance.get_total_irradiance(
        surface_tilt=p.tilt_deg,
        surface_azimuth=p.azimuth_deg,
        solar_zenith=zenith,
        solar_azimuth=azimuth,
        dni=dni,
        ghi=ghi,
        dhi=dhi,
        dni_extra=dni_extra,
        airmass=airmass,
        albedo=p.albedo,
        model="perez",
    )
    return pd.DataFrame({"poa_global_w_m2": np.maximum(poa["poa_global"], 0)}, index=weather.index)


def calculate_cell_temperature(weather: pd.DataFrame, poa_global_w_m2: pd.Series) -> pd.Series:
    params = pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"]["open_rack_glass_polymer"]
    return pvlib.temperature.sapm_cell(
        poa_global_w_m2,
        weather["temp_air_c"],
        weather["wind_speed_m_s"],
        **params,
    )


def soiling_profile(index: pd.DatetimeIndex) -> np.ndarray:
    days = ((index - index[0]).days.to_numpy() % 35).astype(float)
    soiling = 1 - np.minimum(days * 0.0015, 0.05)
    rain_like_cleaning = index.day.isin([5, 19])
    soiling = np.where(rain_like_cleaning, 1.0, soiling)
    return np.clip(soiling, 0.94, 1.0)


def simulate_expected_pv(weather: pd.DataFrame) -> pd.DataFrame:
    p = plant()
    m = module()
    idx = pd.DatetimeIndex(weather["timestamp"])
    poa = calculate_poa(weather)
    cell_temp = calculate_cell_temperature(weather, poa["poa_global_w_m2"])
    raw_dc = p.dc_capacity_kwp * (poa["poa_global_w_m2"] / 1000) * (1 + m.gamma_pdc_per_c * (cell_temp - 25))
    raw_dc = np.maximum(raw_dc, 0)
    loss_factors = {
        "optical_loss_kwh": 0.018,
        "soiling_loss_kwh": 1 - soiling_profile(idx),
        "mismatch_loss_kwh": 0.012,
        "dc_wiring_loss_kwh": 0.015,
        "shading_loss_kwh": 0.008,
        "degradation_loss_kwh": np.minimum(((idx.year - idx.year.min()) + idx.dayofyear / 365.25) * 0.006, 0.02),
    }
    factor = np.ones(len(weather))
    for _key, value in loss_factors.items():
        if np.isscalar(value):
            factor *= 1 - float(value)
        else:
            factor *= 1 - value
    dc_power = raw_dc * factor
    inverter_eff = 0.985
    ac_before_clip = dc_power * inverter_eff
    ac_power = np.minimum(ac_before_clip, p.ac_capacity_kw)
    clipping_kw = np.maximum(ac_before_clip - p.ac_capacity_kw, 0)
    dt = 1.0
    out = weather.copy()
    out["poa_global_w_m2"] = poa["poa_global_w_m2"].to_numpy()
    out["cell_temperature_c"] = cell_temp.to_numpy()
    out["dc_power_kw"] = dc_power.to_numpy()
    out["available_power_kw"] = ac_before_clip.to_numpy()
    out["expected_power_kw"] = ac_power.to_numpy()
    out["ac_power_kw"] = ac_power.to_numpy()
    out["dc_energy_kwh"] = out["dc_power_kw"] * dt
    out["ac_energy_kwh"] = out["ac_power_kw"] * dt
    out["expected_energy_kwh"] = out["expected_power_kw"] * dt
    out["inverter_efficiency_pct"] = inverter_eff * 100
    out["clipping_kwh"] = clipping_kw.to_numpy() * dt
    out["curtailment_kwh"] = 0.0
    for key, val in loss_factors.items():
        if np.isscalar(val):
            out[key] = raw_dc.to_numpy() * float(val) * dt
        else:
            out[key] = raw_dc.to_numpy() * val * dt
    out["inverter_conversion_loss_kwh"] = out["dc_power_kw"] * (1 - inverter_eff) * dt
    out["ac_wiring_loss_kwh"] = out["ac_energy_kwh"] * 0.006
    out["transformer_loss_kwh"] = out["ac_energy_kwh"] * 0.004
    return out


def generate_load(times: pd.Series) -> pd.DataFrame:
    idx = pd.DatetimeIndex(times)
    rng = np.random.default_rng(7)
    hour = idx.hour.to_numpy()
    weekday = idx.dayofweek.to_numpy()
    month = idx.month.to_numpy()
    working = weekday < 5
    base = np.where(working, 520, 360)
    shift = np.where((hour >= 7) & (hour <= 18), 210, 45)
    evening = np.where((hour >= 18) & (hour <= 21), 90, 0)
    seasonal = 55 * np.sin(2 * np.pi * (month - 1) / 12)
    peaks = np.where((working) & (hour.isin([9, 10, 15, 16]) if hasattr(hour, "isin") else np.isin(hour, [9, 10, 15, 16])), 85, 0)
    load = np.clip(base + shift + evening + seasonal + peaks + rng.normal(0, 24, len(idx)), 260, 980)
    return pd.DataFrame({"timestamp": idx, "load_kw": load, "load_kwh": load})


def inject_faults(expected: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = expected.copy()
    df["measured_power_kw"] = df["expected_power_kw"]
    df["measured_energy_kwh"] = df["expected_energy_kwh"]
    df["fault_code"] = "NORMAL"
    df["availability_factor"] = 1.0
    events = [
        ("FLT-001", "String Offline", "STR-0042", "2024-03-12 08:00", "2024-03-15 17:00", 0.985, "Media"),
        ("FLT-002", "MPPT Underperformance", "MPPT-INV-02-07", "2024-06-03 09:00", "2024-06-10 18:00", 0.93, "Alta"),
        ("FLT-003", "Inverter Shutdown", "INV-03", "2024-09-20 11:00", "2024-09-21 16:00", 0.75, "Critica"),
        ("FLT-004", "Soiling Excessivo", "ARRAY-02", "2025-01-10 08:00", "2025-02-05 17:00", 0.94, "Media"),
        ("FLT-005", "Partial Shading", "ARRAY-01", "2025-04-14 07:00", "2025-04-25 18:00", 0.96, "Baixa"),
        ("FLT-006", "Sensor Fault", "MET-POA-01", "2025-07-06 00:00", "2025-07-08 23:00", 1.0, "Info"),
        ("FLT-007", "High Temperature", "INV-04", "2025-09-10 12:00", "2025-09-15 16:00", 0.97, "Media"),
        ("FLT-008", "DC Loss", "COMBINER-01", "2025-10-01 09:00", "2025-10-05 16:00", 0.955, "Alta"),
        ("FLT-009", "AC Loss", "TRAFO-01", "2025-11-04 08:00", "2025-11-07 18:00", 0.965, "Alta"),
        ("FLT-010", "Grid Disconnection", "GRID-METER", "2024-12-02 13:00", "2024-12-02 15:00", 0.0, "Critica"),
        ("FLT-011", "Curtailment", "PPC-01", "2025-12-15 10:00", "2025-12-17 15:00", 0.86, "Media"),
        ("FLT-012", "Communication Failure", "SCADA-01", "2024-05-08 00:00", "2024-05-09 23:00", 1.0, "Baixa"),
    ]
    idx = pd.DatetimeIndex(df["timestamp"])
    rng = np.random.default_rng(99)
    noise = rng.normal(0, 0.012, len(df))
    daylight = df["expected_power_kw"] > 5
    df.loc[daylight, "measured_power_kw"] *= np.clip(1 + noise[daylight.to_numpy()], 0.95, 1.04)
    records = []
    for fid, kind, asset, start, end, factor, sev in events:
        start_ts = pd.Timestamp(start, tz=idx.tz)
        end_ts = pd.Timestamp(end, tz=idx.tz)
        mask = (idx >= start_ts) & (idx <= end_ts) & daylight
        before = df.loc[mask, "measured_power_kw"].copy()
        if kind == "Sensor Fault":
            df.loc[mask, "measured_power_kw"] = df.loc[mask, "measured_power_kw"] * 1.08
        elif kind == "Communication Failure":
            df.loc[mask, "measured_power_kw"] = np.nan
        elif kind == "Curtailment":
            curtailed = before * (1 - factor)
            df.loc[mask, "curtailment_kwh"] += curtailed
            df.loc[mask, "measured_power_kw"] = before * factor
        else:
            df.loc[mask, "measured_power_kw"] = before * factor
            df.loc[mask, "availability_factor"] *= factor
        df.loc[mask, "fault_code"] = kind.upper().replace(" ", "_")
        lost = float((before.fillna(0) - df.loc[mask, "measured_power_kw"].fillna(0)).clip(lower=0).sum())
        records.append(
            {
                "fault_id": fid,
                "fault_type": kind,
                "asset_id": asset,
                "start": start_ts.isoformat(),
                "end": end_ts.isoformat(),
                "severity": sev,
                "energy_lost_kwh": lost,
                "classification": "dado sintetico",
            }
        )
    df["measured_power_kw"] = df["measured_power_kw"].fillna(0).clip(lower=0)
    df["measured_energy_kwh"] = df["measured_power_kw"]
    df["grid_export_kwh"] = df["measured_energy_kwh"]
    return df, pd.DataFrame(records)


def compare_twin(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["absolute_error_kw"] = out["measured_power_kw"] - out["expected_power_kw"]
    out["residual_kw"] = out["absolute_error_kw"]
    denom = out["expected_power_kw"].replace(0, np.nan)
    out["relative_error_pct"] = (out["absolute_error_kw"] / denom * 100).fillna(0)
    return out


def twin_metrics(df: pd.DataFrame) -> dict[str, float]:
    day = df["expected_power_kw"] > 5
    err = (df.loc[day, "measured_power_kw"] - df.loc[day, "expected_power_kw"]).to_numpy()
    y = df.loc[day, "measured_power_kw"].to_numpy()
    yhat = df.loc[day, "expected_power_kw"].to_numpy()
    mae = float(np.mean(np.abs(err)))
    rmse = float(np.sqrt(np.mean(err**2)))
    nrmse = float(rmse / plant().ac_capacity_kw)
    mbe = float(np.mean(err))
    ss_res = float(np.sum((y - yhat) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return {"mae_kw": mae, "rmse_kw": rmse, "nrmse_pct": nrmse * 100, "mbe_kw": mbe, "r2": float(r2)}


def performance_kpis(df: pd.DataFrame) -> dict[str, float]:
    p = plant()
    poa_kwh_m2 = float((df["poa_global_w_m2"] / 1000).sum())
    ac_energy = float(df["measured_energy_kwh"].sum())
    expected = float(df["expected_energy_kwh"].sum())
    yr = poa_kwh_m2
    yf = ac_energy / p.dc_capacity_kwp
    pr = yf / yr if yr else 0
    availability = float(df["measured_energy_kwh"].sum() / df["expected_energy_kwh"].sum())
    return {
        "installed_dc_kwp": p.dc_capacity_kwp,
        "installed_ac_kw": p.ac_capacity_kw,
        "dc_ac_ratio": p.dc_ac_ratio,
        "annual_generation_kwh": ac_energy / 2,
        "total_generation_kwh": ac_energy,
        "expected_total_kwh": expected,
        "performance_ratio": pr,
        "specific_yield_kwh_kwp": ac_energy / 2 / p.dc_capacity_kwp,
        "final_yield_kwh_kwp": yf / 2,
        "reference_yield_kwh_m2": yr / 2,
        "capacity_factor": ac_energy / (p.ac_capacity_kw * len(df)),
        "availability": min(availability, 1.0),
        "clipping_kwh": float(df["clipping_kwh"].sum()),
        "curtailment_kwh": float(df["curtailment_kwh"].sum()),
    }


def loss_tree(df: pd.DataFrame) -> pd.DataFrame:
    loss_cols = [
        "optical_loss_kwh",
        "soiling_loss_kwh",
        "mismatch_loss_kwh",
        "dc_wiring_loss_kwh",
        "shading_loss_kwh",
        "degradation_loss_kwh",
        "inverter_conversion_loss_kwh",
        "ac_wiring_loss_kwh",
        "transformer_loss_kwh",
        "clipping_kwh",
        "curtailment_kwh",
    ]
    labels = {
        "optical_loss_kwh": "Perdas opticas",
        "soiling_loss_kwh": "Soiling",
        "mismatch_loss_kwh": "Mismatch",
        "dc_wiring_loss_kwh": "Cabos DC",
        "shading_loss_kwh": "Sombreamento",
        "degradation_loss_kwh": "Degradacao FV",
        "inverter_conversion_loss_kwh": "Conversao inversor",
        "ac_wiring_loss_kwh": "Cabos AC",
        "transformer_loss_kwh": "Transformador",
        "clipping_kwh": "Clipping",
        "curtailment_kwh": "Curtailment",
    }
    rows = []
    revenue = 0.62
    total_available = float(df["dc_energy_kwh"].sum() + sum(df[c].sum() for c in loss_cols if c in df))
    for col in loss_cols:
        kwh = float(df[col].sum()) if col in df else 0.0
        rows.append({"loss": labels[col], "kwh": kwh, "mwh": kwh / 1000, "pct_of_available": kwh / total_available if total_available else 0, "brl": kwh * revenue})
    return pd.DataFrame(rows).sort_values("kwh", ascending=False)


def detect_anomalies(twin: pd.DataFrame, ground_truth: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float]]:
    df = twin.copy()
    day = df["expected_power_kw"] > 20
    residual = df["residual_kw"].fillna(0)
    rolling_mean = residual.rolling(72, min_periods=12).mean()
    rolling_std = residual.rolling(72, min_periods=12).std().replace(0, np.nan)
    df["rolling_z_score"] = ((residual - rolling_mean) / rolling_std).fillna(0)
    df["residual_threshold_flag"] = (df["relative_error_pct"] < -6) & day
    features = df[["relative_error_pct", "poa_global_w_m2", "cell_temperature_c", "measured_power_kw"]].fillna(0)
    model = IsolationForest(n_estimators=80, contamination=0.018, random_state=22)
    df["isolation_forest_flag"] = model.fit_predict(features) == -1
    df["anomaly_flag"] = df["residual_threshold_flag"] | (df["rolling_z_score"].abs() > 3.0) | df["isolation_forest_flag"]
    truth = pd.Series(False, index=df.index)
    idx = pd.DatetimeIndex(df["timestamp"])
    for _, row in ground_truth.iterrows():
        start = pd.Timestamp(row["start"])
        end = pd.Timestamp(row["end"])
        truth |= (idx >= start) & (idx <= end) & day.to_numpy()
    df["ground_truth_fault"] = truth
    metrics = {
        "precision": float(precision_score(truth, df["anomaly_flag"], zero_division=0)),
        "recall": float(recall_score(truth, df["anomaly_flag"], zero_division=0)),
        "f1": float(f1_score(truth, df["anomaly_flag"], zero_division=0)),
    }
    return df, metrics


def om_events(ground_truth: pd.DataFrame) -> pd.DataFrame:
    sev_score = {"Info": 1, "Baixa": 2, "Media": 3, "Alta": 4, "Critica": 5}
    actions = {
        "String Offline": "Inspecionar strings associadas ao MPPT e verificar conectores com procedimento seguro.",
        "MPPT Underperformance": "Comparar curvas I-V do MPPT e revisar sombreamento, sujeira e conexoes.",
        "Inverter Shutdown": "Verificar log do inversor e acionar manutencao autorizada.",
        "Soiling Excessivo": "Programar limpeza conforme procedimento do site e disponibilidade de agua.",
        "Curtailment": "Revisar comandos do PPC e restricoes operacionais externas.",
    }
    df = ground_truth.copy()
    df["duration_h"] = (pd.to_datetime(df["end"]) - pd.to_datetime(df["start"])).dt.total_seconds() / 3600
    df["financial_impact_brl"] = df["energy_lost_kwh"] * 0.62
    df["priority_score"] = df["severity"].map(sev_score).fillna(2) * np.log1p(df["energy_lost_kwh"])
    df["status"] = np.where(df["priority_score"] > 20, "Open", np.where(df["priority_score"] > 8, "In Progress", "Closed"))
    df["suggested_action"] = df["fault_type"].map(actions).fillna("Investigar tendencia e confirmar em campo antes de classificar como falha.")
    return df.sort_values("priority_score", ascending=False)


def dispatch_bess(
    pv_kwh: np.ndarray,
    load_kwh: np.ndarray,
    tariffs: np.ndarray,
    cfg: BESS,
    strategy: str = "optimized",
    peak_target_kw: float = 850.0,
) -> pd.DataFrame:
    n = len(pv_kwh)
    soc = cfg.energy_kwh * cfg.soc_initial_pct / 100
    min_soc = cfg.energy_kwh * cfg.soc_min_pct / 100
    max_soc = cfg.energy_kwh * cfg.soc_max_pct / 100
    reserve_soc = cfg.energy_kwh * max(cfg.reserve_soc_pct, cfg.soc_min_pct) / 100
    rows = []
    low_price = np.quantile(tariffs, 0.35)
    high_price = np.quantile(tariffs, 0.72)
    for i in range(n):
        pv = float(pv_kwh[i])
        load = float(load_kwh[i])
        tariff = float(tariffs[i])
        charge_input = 0.0
        discharge = 0.0
        curtailment = 0.0
        pv_to_load = min(pv, load)
        surplus = max(pv - pv_to_load, 0.0)
        surplus_before_charge = surplus
        deficit = max(load - pv_to_load, 0.0)
        effective_min = reserve_soc if strategy in {"reserve_soc", "multi_objective", "optimized"} else min_soc
        if strategy in {"self_consumption", "curtailment_recovery", "optimized", "multi_objective"} and surplus > 0:
            charge_input = min(surplus, cfg.power_kw, (max_soc - soc) / cfg.charge_efficiency)
        elif strategy in {"arbitrage", "optimized", "multi_objective"} and tariff <= low_price and soc < max_soc:
            grid_room = max_soc - soc
            charge_input = min(cfg.power_kw, grid_room / cfg.charge_efficiency)
            if strategy in {"optimized", "multi_objective"}:
                charge_input = min(charge_input, max(peak_target_kw - load, 0.0))
        if charge_input > 0:
            soc += charge_input * cfg.charge_efficiency
            surplus = max(surplus - charge_input, 0)
        elif deficit > 0:
            wants_peak = strategy in {"peak_shaving", "optimized", "multi_objective"} and deficit > max(peak_target_kw - pv_to_load, 0)
            wants_arbitrage = strategy in {"arbitrage", "optimized", "multi_objective"} and tariff >= high_price
            wants_self = strategy in {"self_consumption", "optimized", "multi_objective"}
            if wants_peak or wants_arbitrage or wants_self:
                available = max((soc - effective_min) * cfg.discharge_efficiency, 0)
                target = deficit
                if wants_peak:
                    target = max(load - peak_target_kw, 0)
                discharge = min(target, cfg.power_kw, available)
                soc -= discharge / cfg.discharge_efficiency
                deficit -= discharge
        grid_charge = max(charge_input - surplus_before_charge, 0.0)
        grid_import = deficit + grid_charge
        grid_export = surplus
        losses = charge_input * (1 - cfg.charge_efficiency) + (discharge / cfg.discharge_efficiency - discharge if discharge else 0)
        throughput = charge_input + discharge
        efc = throughput / (2 * cfg.energy_kwh) if cfg.energy_kwh else 0
        rows.append(
            {
                "soc_pct": soc / cfg.energy_kwh * 100,
                "energy_stored_kwh": soc,
                "charge_power_kw": charge_input,
                "discharge_power_kw": discharge,
                "charge_energy_kwh": charge_input,
                "discharge_energy_kwh": discharge,
                "bess_losses_kwh": losses,
                "battery_temperature_c": 26 + 0.004 * abs(charge_input - discharge),
                "cycles_equivalent": efc,
                "throughput_kwh": throughput,
                "bess_status": "Charging" if charge_input > 0 else ("Discharging" if discharge > 0 else "Idle"),
                "grid_import_kwh": grid_import,
                "grid_export_kwh": grid_export,
                "pv_to_load_kwh": pv_to_load,
                "curtailment_kwh": curtailment,
                "tariff_brl_kwh": tariff,
                "balance_error_kwh": pv + grid_import + discharge - load - charge_input - grid_export - curtailment,
            }
        )
    out = pd.DataFrame(rows)
    out["cycles_equivalent_cum"] = out["cycles_equivalent"].cumsum()
    out["throughput_kwh_cum"] = out["throughput_kwh"].cumsum()
    out["usable_capacity_kwh"] = cfg.energy_kwh * (1 - out["cycles_equivalent_cum"] * cfg.cycle_degradation_pct_per_efc / 100)
    return out


def tariff_series(times: pd.Series, multiplier: float = 1.0) -> np.ndarray:
    idx = pd.DatetimeIndex(times)
    hour = idx.hour.to_numpy()
    weekday = idx.dayofweek.to_numpy() < 5
    tariff = np.full(len(idx), 0.54)
    tariff[(hour >= 18) & (hour <= 21) & weekday] = 1.05
    tariff[(hour <= 5)] = 0.38
    return tariff * multiplier


def energy_cost(load: np.ndarray, tariffs: np.ndarray) -> float:
    return float(np.sum(load * tariffs))


def demand_cost(grid_import: np.ndarray, demand_rate_brl_kw_month: float = 46.0) -> float:
    s = pd.Series(grid_import)
    months = np.repeat(np.arange(math.ceil(len(s) / 730)), 730)[: len(s)]
    monthly_peak = s.groupby(months).max()
    return float(monthly_peak.sum() * demand_rate_brl_kw_month)


def npv(rate: float, cashflows: list[float]) -> float:
    return float(sum(cf / ((1 + rate) ** i) for i, cf in enumerate(cashflows)))


def irr(cashflows: list[float]) -> float:
    def f(r: float) -> float:
        return sum(cf / ((1 + r) ** i) for i, cf in enumerate(cashflows))

    try:
        return float(brentq(f, -0.95, 1.5))
    except ValueError:
        return float("nan")


def payback(cashflows: list[float], rate: float = 0.0) -> float:
    cumulative = 0.0
    for i, cf in enumerate(cashflows):
        discounted = cf / ((1 + rate) ** i)
        previous = cumulative
        cumulative += discounted
        if i > 0 and cumulative >= 0:
            return (i - 1) + abs(previous) / discounted if discounted else float("inf")
    return float("inf")


def annual_economics(
    pv: pd.DataFrame,
    load: pd.DataFrame,
    bess: pd.DataFrame | None,
    cfg: BESS | None,
    battery_capex_delta_pct: float = 0,
    tariff_delta_pct: float = 0,
) -> dict[str, float | list[float]]:
    tariffs = tariff_series(load["timestamp"], 1 + tariff_delta_pct / 100)
    load_arr = load["load_kwh"].to_numpy()
    base_cost = energy_cost(load_arr, tariffs) + demand_cost(load_arr)
    if bess is None:
        pv_to_load = np.minimum(pv["measured_energy_kwh"].to_numpy(), load_arr)
        grid_import = np.maximum(load_arr - pv_to_load, 0)
        grid_export = np.maximum(pv["measured_energy_kwh"].to_numpy() - pv_to_load, 0)
        bess_capex = 0.0
        bess_opex = 0.0
        discharged = 0.0
        degradation_cost = 0.0
        lcos = 0.0
    else:
        grid_import = bess["grid_import_kwh"].to_numpy()
        grid_export = bess["grid_export_kwh"].to_numpy()
        bess_capex = cfg.energy_kwh * 1200 * (1 + battery_capex_delta_pct / 100) + cfg.power_kw * 650
        bess_opex = 0.015 * bess_capex
        discharged = float(bess["discharge_energy_kwh"].sum()) / 2
        degradation_cost = float(bess["throughput_kwh"].sum()) * 0.035 / 2
        life_costs = bess_capex + sum((bess_opex + degradation_cost) / ((1 + 0.10) ** y) for y in range(1, 11))
        life_energy = sum((max(discharged * (1 - 0.012) ** y, 0)) / ((1 + 0.10) ** y) for y in range(1, 11))
        lcos = life_costs / life_energy if life_energy else 0.0
    scenario_cost = energy_cost(grid_import, tariffs) + demand_cost(grid_import)
    export_credit = float(np.sum(grid_export * 0.28))
    annual_savings = base_cost - scenario_cost + export_credit
    pv_capex = plant().dc_capacity_kwp * 2850
    capex = pv_capex + bess_capex
    opex = plant().dc_capacity_kwp * 42 + bess_opex
    net_annual = annual_savings - opex
    cashflows = [-capex] + [net_annual * (1 + 0.035) ** (y - 1) for y in range(1, 16)]
    cashflows[10] -= bess_capex * 0.28 if bess_capex else 0
    return {
        "baseline_cost_brl": base_cost / 2,
        "scenario_cost_brl": scenario_cost / 2,
        "annual_savings_brl": annual_savings / 2,
        "capex_brl": capex,
        "opex_brl_year": opex,
        "npv_brl": npv(0.10, cashflows),
        "irr": irr(cashflows),
        "payback_years": payback(cashflows),
        "discounted_payback_years": payback(cashflows, 0.10),
        "lcos_brl_kwh": lcos,
        "degradation_cost_brl_year": degradation_cost,
        "cashflows": cashflows,
    }


def optimize_dispatch_linprog(pv: np.ndarray, load: np.ndarray, tariffs: np.ndarray, cfg: BESS) -> dict[str, float]:
    horizon = min(48, len(pv))
    n = horizon
    c = np.r_[tariffs[:n], np.full(n, 0.025)]
    bounds = [(0, None)] * n + [(0, cfg.power_kw)] * n
    # Variables are grid_import and discharge. Constraint keeps discharge under deficit and SOC budget.
    a_ub = []
    b_ub = []
    for i in range(n):
        row = np.zeros(2 * n)
        row[n + i] = 1
        a_ub.append(row)
        b_ub.append(max(load[i] - min(pv[i], load[i]), 0))
    row = np.zeros(2 * n)
    row[n:] = 1 / cfg.discharge_efficiency
    a_ub.append(row)
    b_ub.append(cfg.energy_kwh * (cfg.soc_initial_pct - cfg.soc_min_pct) / 100)
    a_eq = []
    b_eq = []
    for i in range(n):
        row = np.zeros(2 * n)
        row[i] = 1
        row[n + i] = 1
        a_eq.append(row)
        b_eq.append(max(load[i] - min(pv[i], load[i]), 0))
    result = linprog(c, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=b_eq, bounds=bounds, method="highs")
    return {"success": bool(result.success), "objective_brl": float(result.fun if result.success else np.nan), "horizon_h": horizon}


def optimize_bess_size(pv: pd.DataFrame, load: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    grid = [(0, 0), (250, 500), (250, 750), (500, 500), (500, 1000), (500, 1500), (750, 1500), (1000, 2000)]
    rows = []
    tariffs = tariff_series(load["timestamp"])
    for power, energy in grid:
        if power == 0:
            econ = annual_economics(pv, load, None, None)
            peak = float(load["load_kw"].max())
            sc = float(np.minimum(pv["measured_energy_kwh"], load["load_kwh"]).sum() / pv["measured_energy_kwh"].sum())
            lcos = 0
        else:
            cfg = BESS(power_kw=power, energy_kwh=energy)
            disp = dispatch_bess(pv["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariffs, cfg, "optimized")
            econ = annual_economics(pv, load, disp, cfg)
            peak = float(disp["grid_import_kwh"].max())
            used = disp["pv_to_load_kwh"].sum() + disp["charge_energy_kwh"].sum()
            sc = float(min(used / pv["measured_energy_kwh"].sum(), 1.0))
            lcos = econ["lcos_brl_kwh"]
        rows.append(
            {
                "pv_kwp": plant().dc_capacity_kwp,
                "bess_kw": power,
                "bess_kwh": energy,
                "annual_pv_kwh": performance_kpis(pv)["annual_generation_kwh"],
                "peak_demand_kw": peak,
                "peak_reduction_kw": float(load["load_kw"].max() - peak),
                "self_consumption_pct": sc,
                "capex_brl": econ["capex_brl"],
                "annual_savings_brl": econ["annual_savings_brl"],
                "npv_brl": econ["npv_brl"],
                "irr": econ["irr"],
                "payback_years": econ["payback_years"],
                "lcos_brl_kwh": lcos,
            }
        )
    table = pd.DataFrame(rows)
    bess_candidates = table[table["bess_kw"] > 0]
    best = bess_candidates.sort_values(["npv_brl", "payback_years"], ascending=[False, True]).iloc[0].to_dict()
    return table, best


def scenario_table(pv: pd.DataFrame, load: pd.DataFrame) -> pd.DataFrame:
    scenarios = [
        ("S0 - Grid Only", 0, 0, "grid"),
        ("S1 - PV Only", 0, 0, "pv_only"),
        ("S2 - PV + Small BESS", 250, 500, "optimized"),
        ("S3 - PV + Medium BESS", 500, 1000, "optimized"),
        ("S4 - PV + Large BESS", 1000, 2000, "optimized"),
        ("S5 - PV + Optimized BESS", 500, 1000, "optimized"),
        ("S6 - PV + BESS Peak Shaving", 500, 1000, "peak_shaving"),
        ("S7 - PV + BESS Self-Consumption", 500, 1000, "self_consumption"),
        ("S8 - PV + BESS Arbitrage", 500, 1000, "arbitrage"),
    ]
    tariffs = tariff_series(load["timestamp"])
    rows = []
    for name, power, energy, strategy in scenarios:
        if name.startswith("S0"):
            grid_import = load["load_kwh"].to_numpy()
            grid_export = np.zeros(len(load))
            econ = annual_economics(pv.assign(measured_energy_kwh=0), load, None, None)
            self_consumption = 0
            self_sufficiency = 0
            peak = float(load["load_kw"].max())
            curtailment = 0
            lcos = 0
        elif power == 0:
            pv_arr = pv["measured_energy_kwh"].to_numpy()
            load_arr = load["load_kwh"].to_numpy()
            grid_import = np.maximum(load_arr - np.minimum(pv_arr, load_arr), 0)
            grid_export = np.maximum(pv_arr - load_arr, 0)
            econ = annual_economics(pv, load, None, None)
            self_consumption = float(np.minimum(pv_arr, load_arr).sum() / pv_arr.sum())
            self_sufficiency = float(np.minimum(pv_arr, load_arr).sum() / load_arr.sum())
            peak = float(grid_import.max())
            curtailment = float(pv["curtailment_kwh"].sum())
            lcos = 0
        else:
            cfg = BESS(power_kw=power, energy_kwh=energy)
            disp = dispatch_bess(pv["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariffs, cfg, strategy)
            econ = annual_economics(pv, load, disp, cfg)
            grid_import = disp["grid_import_kwh"].to_numpy()
            grid_export = disp["grid_export_kwh"].to_numpy()
            pv_used = disp["pv_to_load_kwh"].sum() + disp["charge_energy_kwh"].sum()
            self_consumption = float(min(pv_used / pv["measured_energy_kwh"].sum(), 1.0))
            self_sufficiency = float((disp["pv_to_load_kwh"].sum() + disp["discharge_energy_kwh"].sum()) / load["load_kwh"].sum())
            peak = float(disp["grid_import_kwh"].max())
            curtailment = float(disp["curtailment_kwh"].sum())
            lcos = float(econ["lcos_brl_kwh"])
        rows.append(
            {
                "scenario": name,
                "pv_kwp": 0 if name.startswith("S0") else plant().dc_capacity_kwp,
                "bess_kw": power,
                "bess_kwh": energy,
                "annual_pv_kwh": 0 if name.startswith("S0") else performance_kpis(pv)["annual_generation_kwh"],
                "grid_import_kwh": float(np.sum(grid_import) / 2),
                "grid_export_kwh": float(np.sum(grid_export) / 2),
                "self_consumption_pct": self_consumption,
                "self_sufficiency_pct": self_sufficiency,
                "peak_demand_kw": peak,
                "peak_reduction_kw": float(load["load_kw"].max() - peak),
                "curtailment_kwh": curtailment / 2,
                "capex_brl": econ["capex_brl"],
                "annual_savings_brl": econ["annual_savings_brl"],
                "npv_brl": econ["npv_brl"],
                "irr": econ["irr"],
                "payback_years": econ["payback_years"],
                "lcos_brl_kwh": lcos,
            }
        )
    return pd.DataFrame(rows)


def sensitivity(pv: pd.DataFrame, load: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows = []
    for capex_delta in [-30, -15, 0, 15, 30]:
        for tariff_delta in [-20, -10, 0, 10, 20]:
            cfg = BESS(power_kw=500, energy_kwh=1000)
            disp = dispatch_bess(
                pv["measured_energy_kwh"].to_numpy(),
                load["load_kwh"].to_numpy(),
                tariff_series(load["timestamp"], 1 + tariff_delta / 100),
                cfg,
                "optimized",
            )
            econ = annual_economics(pv, load, disp, cfg, capex_delta, tariff_delta)
            rows.append({"capex_bess_delta_pct": capex_delta, "tariff_delta_pct": tariff_delta, "npv_brl": econ["npv_brl"], "payback_years": econ["payback_years"]})
    tornado = []
    base = annual_economics(pv, load, dispatch_bess(pv["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariff_series(load["timestamp"]), BESS(), "optimized"), BESS())["npv_brl"]
    for driver, low, high in [
        ("CAPEX BESS", 30, -30),
        ("Tarifa", -20, 20),
        ("Crescimento carga", 0, 10),
        ("Degradacao", -25, 25),
        ("Taxa desconto", -2, 2),
    ]:
        tornado.append({"driver": driver, "low_case_npv_brl": base * (1 + low / 100), "high_case_npv_brl": base * (1 + high / 100), "swing_brl": abs(base * (high - low) / 100)})
    return pd.DataFrame(rows), pd.DataFrame(tornado).sort_values("swing_brl", ascending=False)


def asset_hierarchy() -> pd.DataFrame:
    p = plant()
    rows = [{"asset_id": p.plant_id, "parent_id": "", "asset_type": "PLANTA", "name": p.name}]
    for a in range(1, 5):
        rows.append({"asset_id": f"ARRAY-{a:02d}", "parent_id": p.plant_id, "asset_type": "ARRAY", "name": f"Array {a:02d}"})
    s = 1
    for inv in p.inverters:
        rows.append({"asset_id": inv.inverter_id, "parent_id": p.plant_id, "asset_type": "INVERSOR", "name": inv.inverter_id})
        for mppt in range(1, inv.mppt_count + 1):
            mppt_id = f"MPPT-{inv.inverter_id}-{mppt:02d}"
            rows.append({"asset_id": mppt_id, "parent_id": inv.inverter_id, "asset_type": "MPPT", "name": mppt_id})
            for _ in range(2):
                if s <= p.strings:
                    rows.append({"asset_id": f"STR-{s:04d}", "parent_id": mppt_id, "asset_type": "STRING", "name": f"String {s:04d}"})
                    s += 1
    rows.extend(
        [
            {"asset_id": "MTR-001", "parent_id": p.plant_id, "asset_type": "MEDIDOR", "name": "Revenue Meter"},
            {"asset_id": "TRAFO-01", "parent_id": p.plant_id, "asset_type": "TRANSFORMADOR", "name": "Transformer"},
            {"asset_id": "BESS-001", "parent_id": p.plant_id, "asset_type": "BESS", "name": "BESS"},
            {"asset_id": "PCS-001", "parent_id": "BESS-001", "asset_type": "PCS", "name": "PCS"},
            {"asset_id": "RACK-001", "parent_id": "BESS-001", "asset_type": "RACK", "name": "Rack 001"},
            {"asset_id": "BMS-001", "parent_id": "BESS-001", "asset_type": "BMS", "name": "BMS"},
        ]
    )
    return pd.DataFrame(rows)


def string_dataset(pv: pd.DataFrame) -> pd.DataFrame:
    p = plant()
    latest = pv[pv["poa_global_w_m2"] > 200].tail(1).iloc[0]
    rows = []
    rng = np.random.default_rng(123)
    for i in range(1, p.strings + 1):
        inv = f"INV-{((i - 1) % 4) + 1:02d}"
        mppt = f"MPPT-{inv}-{(((i - 1) // 2) % 12) + 1:02d}"
        voltage = module().vmp_v * p.modules_per_string * np.clip(1 - 0.002 * (latest["cell_temperature_c"] - 25), 0.88, 1.05)
        current = module().imp_a * latest["poa_global_w_m2"] / 1000 * rng.normal(1, 0.02)
        power = voltage * current / 1000
        rows.append({"timestamp": latest["timestamp"], "string_id": f"STR-{i:04d}", "mppt_id": mppt, "inverter_id": inv, "voltage_v": voltage, "current_a": current, "power_kw": power, "status": "OK", "fault_code": "NORMAL"})
    return pd.DataFrame(rows)


def write_outputs() -> dict:
    DATA.mkdir(exist_ok=True)
    for sub in ["raw", "staging", "processed", "portfolio", "synthetic", "external"]:
        (DATA / sub).mkdir(parents=True, exist_ok=True)
    weather = generate_weather()
    expected = simulate_expected_pv(weather)
    observed, faults = inject_faults(expected)
    load = generate_load(observed["timestamp"])
    twin = compare_twin(observed)
    twin_m = twin_metrics(twin)
    perf = performance_kpis(observed)
    losses = loss_tree(observed)
    anomalies, anomaly_metrics = detect_anomalies(twin, faults)
    om = om_events(faults)
    tariffs = tariff_series(load["timestamp"])
    base_cfg = BESS()
    bess = dispatch_bess(observed["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariffs, base_cfg, "optimized")
    bess.insert(0, "timestamp", observed["timestamp"])
    econ = annual_economics(observed, load, bess, base_cfg)
    sizing, best = optimize_bess_size(observed, load)
    scenarios = scenario_table(observed, load)
    sens, tornado = sensitivity(observed, load)
    lp = optimize_dispatch_linprog(observed["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariffs, base_cfg)
    assets = asset_hierarchy()
    strings = string_dataset(observed)
    datasets = {
        "weather.parquet": weather,
        "pv_timeseries.parquet": observed,
        "load.parquet": load,
        "digital_twin.parquet": twin,
        "anomalies.parquet": anomalies,
        "bess_dispatch.parquet": bess,
    }
    for name, df in datasets.items():
        df.to_parquet(DATA / "processed" / name, index=False)
    for name, df in {
        "fault_ground_truth.csv": faults,
        "loss_tree.csv": losses,
        "om_events.csv": om,
        "bess_sizing.csv": sizing,
        "scenarios.csv": scenarios,
        "sensitivity.csv": sens,
        "tornado.csv": tornado,
        "assets.csv": assets,
        "strings.csv": strings,
    }.items():
        df.to_csv(DATA / "portfolio" / name, index=False)
    catalog = []
    for dataset, source, classification, granularity, period, units, desc in [
        ("weather", "pvlib clear-sky + synthetic modifiers", "dado sintetico", "1 hora", "2024-2025", "W/m2, C, m/s", "Serie meteorologica sintetica derivada de geometria solar publica."),
        ("pv_timeseries", "modelo fisico FV", "resultado calculado", "1 hora", "2024-2025", "kW, kWh", "Expected e measured AC/DC, clipping, curtailment e perdas."),
        ("load", "perfil industrial ficticio", "dado sintetico", "1 hora", "2024-2025", "kW, kWh", "Carga industrial com dias uteis, fins de semana e sazonalidade."),
        ("fault_ground_truth", "fault injection engine", "dado sintetico", "evento", "2024-2025", "kWh, h", "Falhas sinteticas com ativo, periodo e perda."),
        ("bess_dispatch", "modelo BESS", "resultado calculado", "1 hora", "2024-2025", "kW, kWh, %", "SOC, carga, descarga, importacao, exportacao e perdas."),
        ("economics", "modelo economico configuravel", "resultado calculado", "anual", "15 anos", "BRL", "CAPEX, OPEX, VPL, TIR, payback e LCOS."),
    ]:
        catalog.append({"dataset": dataset, "source": source, "classification": classification, "granularity": granularity, "period": period, "units": units, "description": desc})
    (DATA / "data_catalog.yaml").write_text(yaml.safe_dump(catalog, allow_unicode=True, sort_keys=False), encoding="utf-8")
    results = {
        "plant": asdict(plant()),
        "performance": perf,
        "digital_twin": twin_m,
        "anomaly_detection": anomaly_metrics,
        "economics": {k: v for k, v in econ.items() if k != "cashflows"},
        "best_bess": best,
        "optimizer_validation": lp,
        "bess": {
            "throughput_kwh": float(bess["throughput_kwh"].sum()),
            "equivalent_cycles": float(bess["cycles_equivalent"].sum()),
            "peak_reduction_kw": float(load["load_kw"].max() - bess["grid_import_kwh"].max()),
            "self_consumption_before_pct": float(np.minimum(observed["measured_energy_kwh"], load["load_kwh"]).sum() / observed["measured_energy_kwh"].sum()),
            "self_consumption_after_pct": float(min((bess["pv_to_load_kwh"].sum() + bess["charge_energy_kwh"].sum()) / observed["measured_energy_kwh"].sum(), 1.0)),
            "self_sufficiency_after_pct": float((bess["pv_to_load_kwh"].sum() + bess["discharge_energy_kwh"].sum()) / load["load_kwh"].sum()),
            "max_balance_error_kwh": float(bess["balance_error_kwh"].abs().max()),
        },
        "losses": losses.head(5).to_dict(orient="records"),
    }
    RESULTS.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    write_sqlite(weather, observed, load, faults, bess, econ, assets, strings)
    return results


def write_sqlite(weather, pv, load, faults, bess, econ, assets, strings) -> None:
    db = DATA / "portfolio" / "pv_digital_twin.db"
    plant_row = asdict(plant())
    plant_row["inverters"] = json.dumps(plant_row["inverters"], ensure_ascii=False)
    with sqlite3.connect(db) as con:
        pd.DataFrame([plant_row]).to_sql("DimPlant", con, if_exists="replace", index=False)
        assets.to_sql("DimAsset", con, if_exists="replace", index=False)
        pd.DataFrame([asdict(inv) for inv in plant().inverters]).to_sql("DimInverter", con, if_exists="replace", index=False)
        strings.to_sql("DimString", con, if_exists="replace", index=False)
        pd.DataFrame([asdict(BESS())]).to_sql("DimBESS", con, if_exists="replace", index=False)
        weather.head(5000).to_sql("FactWeather", con, if_exists="replace", index=False)
        pv.head(5000).to_sql("FactPV", con, if_exists="replace", index=False)
        pv[["timestamp", "expected_energy_kwh", "measured_energy_kwh", "poa_global_w_m2"]].head(5000).to_sql("FactPerformance", con, if_exists="replace", index=False)
        faults.to_sql("FactFaults", con, if_exists="replace", index=False)
        bess.head(5000).to_sql("FactBESS", con, if_exists="replace", index=False)
        pd.DataFrame([{k: v for k, v in econ.items() if k != "cashflows"}]).to_sql("FactEconomics", con, if_exists="replace", index=False)


def load_results() -> dict:
    if not RESULTS.exists():
        return write_outputs()
    return json.loads(RESULTS.read_text(encoding="utf-8"))


def create_insights() -> list[str]:
    r = load_results()
    losses = pd.read_csv(DATA / "portfolio" / "loss_tree.csv")
    scenarios = pd.read_csv(DATA / "portfolio" / "scenarios.csv")
    sizing = pd.read_csv(DATA / "portfolio" / "bess_sizing.csv")
    om = pd.read_csv(DATA / "portfolio" / "om_events.csv")
    insights = [
        f"A geracao anual calculada foi {r['performance']['annual_generation_kwh'] / 1000:.1f} MWh/ano.",
        f"O PR calculado foi {r['performance']['performance_ratio']:.3f}, usando Yf/Yr.",
        f"O specific yield foi {r['performance']['specific_yield_kwh_kwp']:.1f} kWh/kWp.ano.",
        f"A maior perda anual foi {losses.iloc[0]['loss']} com {losses.iloc[0]['mwh'] / 2:.1f} MWh/ano.",
        f"O clipping total medio anual foi {r['performance']['clipping_kwh'] / 2 / 1000:.1f} MWh/ano.",
        f"O curtailment medio anual foi {r['performance']['curtailment_kwh'] / 2 / 1000:.1f} MWh/ano.",
        f"O melhor BESS por NPV na grade foi {r['best_bess']['bess_kw']:.0f} kW / {r['best_bess']['bess_kwh']:.0f} kWh.",
        f"A reducao de pico com BESS base foi {r['bess']['peak_reduction_kw']:.1f} kW.",
        f"O autoconsumo subiu de {r['bess']['self_consumption_before_pct']:.1%} para {r['bess']['self_consumption_after_pct']:.1%}.",
        f"O LCOS calculado do BESS base foi R$ {r['economics']['lcos_brl_kwh']:.2f}/kWh descarregado.",
        f"O VPL do caso base PV+BESS foi R$ {r['economics']['npv_brl']:,.0f}.",
        f"A TIR do caso base foi {r['economics']['irr']:.1%}.",
        f"O payback simples foi {r['economics']['payback_years']:.1f} anos.",
        f"O payback descontado foi {r['economics']['discounted_payback_years']:.1f} anos.",
        f"O MAE do Digital Twin foi {r['digital_twin']['mae_kw']:.2f} kW.",
        f"O RMSE do Digital Twin foi {r['digital_twin']['rmse_kw']:.2f} kW.",
        f"O nRMSE foi {r['digital_twin']['nrmse_pct']:.2f}% da potencia AC.",
        f"O R2 entre esperado e observado foi {r['digital_twin']['r2']:.4f}.",
        f"A deteccao de anomalias teve precision {r['anomaly_detection']['precision']:.2f}.",
        f"A deteccao de anomalias teve recall {r['anomaly_detection']['recall']:.2f}.",
        f"A deteccao de anomalias teve F1 {r['anomaly_detection']['f1']:.2f}.",
        f"O maior evento de O&M foi {om.iloc[0]['fault_type']} no ativo {om.iloc[0]['asset_id']}.",
        f"A estrategia otimizada respeitou erro maximo de balanco de {r['bess']['max_balance_error_kwh']:.6f} kWh.",
        f"O throughput medio anual do BESS foi {r['bess']['throughput_kwh'] / 2:.0f} kWh/ano.",
        f"Os ciclos equivalentes medios anuais foram {r['bess']['equivalent_cycles'] / 2:.1f} EFC/ano.",
        f"O cenario com maior VPL foi {scenarios.sort_values('npv_brl', ascending=False).iloc[0]['scenario']}.",
        f"O cenario com menor LCOS nao nulo foi {scenarios[scenarios['lcos_brl_kwh'] > 0].sort_values('lcos_brl_kwh').iloc[0]['scenario']}.",
        f"A grade de sizing avaliou {len(sizing)} combinacoes de potencia/energia.",
        f"O maior peak reduction na tabela de sizing foi {sizing['peak_reduction_kw'].max():.1f} kW.",
        f"O menor payback na tabela de sizing foi {sizing['payback_years'].replace(np.inf, np.nan).min():.1f} anos.",
        f"A disponibilidade energetica sintetica foi {r['performance']['availability']:.2%}.",
        f"O capacity factor AC calculado foi {r['performance']['capacity_factor']:.2%}.",
    ]
    return insights


def save_figures() -> None:
    import matplotlib.pyplot as plt

    r = load_results()
    pv = pd.read_parquet(DATA / "processed" / "pv_timeseries.parquet")
    bess = pd.read_parquet(DATA / "processed" / "bess_dispatch.parquet")
    losses = pd.read_csv(DATA / "portfolio" / "loss_tree.csv")
    scenarios = pd.read_csv(DATA / "portfolio" / "scenarios.csv")
    om = pd.read_csv(DATA / "portfolio" / "om_events.csv")
    sens = pd.read_csv(DATA / "portfolio" / "sensitivity.csv")
    colors = ["#12372A", "#2E7D32", "#D6A620", "#F8FAF7", "#263238"]

    def fig(path, title, plotter):
        plt.figure(figsize=(12, 7), facecolor="#F8FAF7")
        ax = plt.gca()
        ax.set_facecolor("#F8FAF7")
        plotter(ax)
        plt.title(title, color="#12372A", fontsize=15, fontweight="bold")
        plt.tight_layout()
        plt.savefig(ROOT / path, dpi=140)
        plt.close()

    sample = pv.iloc[:24 * 10]
    fig("assets/screenshots/01_executive.png", "Executive KPIs", lambda ax: ax.bar(["PV MWh", "PR %", "NPV R$M", "LCOS"], [r["performance"]["annual_generation_kwh"] / 1000, r["performance"]["performance_ratio"] * 100, r["economics"]["npv_brl"] / 1e6, r["economics"]["lcos_brl_kwh"]], color=colors[:4]))
    fig("assets/screenshots/02_digital_twin.png", "Digital Twin Expected vs Observed", lambda ax: (ax.plot(sample["timestamp"], sample["expected_power_kw"], color=colors[1], label="Expected"), ax.plot(sample["timestamp"], sample["measured_power_kw"], color=colors[2], label="Observed"), ax.legend()))
    fig("assets/screenshots/03_pv_model.png", "POA and AC Power", lambda ax: (ax.plot(sample["timestamp"], sample["poa_global_w_m2"], color=colors[2], label="POA"), ax.plot(sample["timestamp"], sample["ac_power_kw"], color=colors[1], label="AC kW"), ax.legend()))
    fig("assets/screenshots/04_performance.png", "Monthly PV Energy", lambda ax: pv.assign(month=pd.to_datetime(pv["timestamp"]).dt.to_period("M").astype(str)).groupby("month")["measured_energy_kwh"].sum().plot(kind="bar", ax=ax, color=colors[1]))
    fig("assets/screenshots/05_losses.png", "Loss Ranking", lambda ax: ax.barh(losses["loss"], losses["mwh"], color=colors[2]))
    fig("assets/screenshots/06_strings.png", "String Power Snapshot", lambda ax: pd.read_csv(DATA / "portfolio" / "strings.csv").head(30).plot(x="string_id", y="power_kw", kind="bar", ax=ax, color=colors[1], legend=False))
    fig("assets/screenshots/07_faults.png", "Fault Energy Impact", lambda ax: pd.read_csv(DATA / "portfolio" / "fault_ground_truth.csv").plot(x="fault_type", y="energy_lost_kwh", kind="bar", ax=ax, color=colors[2], legend=False))
    fig("assets/screenshots/08_om.png", "O&M Priority", lambda ax: om.plot(x="asset_id", y="priority_score", kind="bar", ax=ax, color=colors[0], legend=False))
    fig("assets/screenshots/09_bess.png", "BESS SOC", lambda ax: ax.plot(pd.to_datetime(bess["timestamp"]).iloc[:240], bess["soc_pct"].iloc[:240], color=colors[1]))
    fig("assets/screenshots/10_dispatch.png", "Charge and Discharge", lambda ax: (ax.plot(pd.to_datetime(bess["timestamp"]).iloc[:240], bess["charge_power_kw"].iloc[:240], color=colors[1], label="Charge"), ax.plot(pd.to_datetime(bess["timestamp"]).iloc[:240], bess["discharge_power_kw"].iloc[:240], color=colors[2], label="Discharge"), ax.legend()))
    fig("assets/screenshots/11_balance.png", "Grid Import and Export", lambda ax: (ax.plot(pd.to_datetime(bess["timestamp"]).iloc[:240], bess["grid_import_kwh"].iloc[:240], color=colors[0], label="Import"), ax.plot(pd.to_datetime(bess["timestamp"]).iloc[:240], bess["grid_export_kwh"].iloc[:240], color=colors[2], label="Export"), ax.legend()))
    fig("assets/screenshots/12_economics.png", "Scenario NPV", lambda ax: scenarios.plot(x="scenario", y="npv_brl", kind="bar", ax=ax, color=colors[1], legend=False))
    fig("assets/screenshots/13_scenarios.png", "Scenario Peak Reduction", lambda ax: scenarios.plot(x="scenario", y="peak_reduction_kw", kind="bar", ax=ax, color=colors[2], legend=False))
    fig("assets/screenshots/14_sensitivity.png", "NPV Sensitivity", lambda ax: sens.pivot(index="capex_bess_delta_pct", columns="tariff_delta_pct", values="npv_brl").plot(ax=ax, marker="o"))
    draw_architecture_images()
    draw_linkedin_images(r)


def draw_linkedin_images(results: dict) -> None:
    for path, size in [("assets/linkedin/capa_projeto_linkedin.png", (1200, 627)), ("assets/linkedin/projeto_linkedin_1080x1080.png", (1080, 1080))]:
        img = Image.new("RGB", size, "#12372A")
        d = ImageDraw.Draw(img)
        w, h = size
        d.rectangle([0, h * 0.62, w, h], fill="#F8FAF7")
        for i in range(18):
            x = 70 + i * (w - 140) / 18
            y = h * 0.40 + (i % 3) * 12
            d.polygon([(x, y), (x + 46, y - 18), (x + 92, y), (x + 46, y + 18)], fill="#2E7D32", outline="#D6A620")
        d.rectangle([w * 0.68, h * 0.33, w * 0.90, h * 0.59], fill="#263238", outline="#D6A620", width=4)
        d.text((60, 70), "SOLAR PV DIGITAL TWIN\n& BESS OPTIMIZATION PLATFORM", fill="#FFFFFF")
        d.text((60, 185), "PV Performance - Digital Twin - BESS - O&M - Optimization", fill="#D6A620")
        d.line([60, h * 0.68, w - 60, h * 0.68], fill="#D6A620", width=4)
        d.text((60, h * 0.72), f"PV {results['plant']['dc_capacity_kwp'] / 1000:.2f} MWp / BESS {results['best_bess']['bess_kw']:.0f} kW {results['best_bess']['bess_kwh']:.0f} kWh", fill="#12372A")
        img.save(ROOT / path)


def draw_architecture_images() -> None:
    diagrams = {
        "assets/architecture/system_architecture.png": ["Weather", "PV Physical Model", "Digital Twin", "Performance", "Faults + O&M", "BESS Dispatch", "Economics"],
        "assets/architecture/energy_flow.png": ["Solar", "PV AC", "Load", "BESS", "Grid", "Curtailment"],
        "assets/architecture/loss_tree.png": ["POA", "Optical", "Temperature", "Soiling", "Mismatch", "Clipping", "Delivered AC"],
    }
    for path, nodes in diagrams.items():
        img = Image.new("RGB", (1400, 780), "#F8FAF7")
        d = ImageDraw.Draw(img)
        x = 80
        y = 320
        for i, node in enumerate(nodes):
            d.rounded_rectangle([x, y, x + 160, y + 80], radius=8, fill="#12372A" if i % 2 == 0 else "#2E7D32", outline="#D6A620", width=3)
            d.text((x + 18, y + 28), node, fill="#FFFFFF")
            if i < len(nodes) - 1:
                d.line([x + 160, y + 40, x + 230, y + 40], fill="#D6A620", width=5)
            x += 210
        d.text((70, 70), Path(path).stem.replace("_", " ").title(), fill="#12372A")
        img.save(ROOT / path)
