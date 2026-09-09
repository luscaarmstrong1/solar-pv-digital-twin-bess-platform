import math
import importlib

import numpy as np
import pandas as pd
import pytest

from src.models import BESS
from src.platform_core import (
    DATA,
    ROOT,
    annual_economics,
    asset_hierarchy,
    calculate_cell_temperature,
    calculate_poa,
    compare_twin,
    create_insights,
    detect_anomalies,
    dispatch_bess,
    generate_load,
    generate_weather,
    inject_faults,
    irr,
    load_results,
    loss_tree,
    npv,
    om_events,
    optimize_bess_size,
    optimize_dispatch_linprog,
    payback,
    performance_kpis,
    plant,
    scenario_table,
    save_figures,
    sensitivity,
    simulate_expected_pv,
    tariff_series,
    twin_metrics,
    write_outputs,
)


@pytest.fixture(scope="session")
def sample():
    w = generate_weather("2024-01-01", "2024-01-31 23:00")
    pv = simulate_expected_pv(w)
    obs, faults = inject_faults(pv)
    load = generate_load(obs["timestamp"])
    return w, pv, obs, faults, load


def test_solar_position(sample):
    w, *_ = sample
    assert w["solar_zenith_deg"].between(0, 180).all()


def test_poa(sample):
    w, *_ = sample
    poa = calculate_poa(w)
    assert poa["poa_global_w_m2"].min() >= 0


def test_temperature(sample):
    w, *_ = sample
    poa = calculate_poa(w)
    cell = calculate_cell_temperature(w, poa["poa_global_w_m2"])
    assert cell.max() > w["temp_air_c"].max()


def test_dc_power(sample):
    _, pv, *_ = sample
    assert pv["dc_power_kw"].max() > 500


def test_inverter_clipping(sample):
    _, pv, *_ = sample
    assert pv["ac_power_kw"].max() <= plant().ac_capacity_kw + 1e-9


def test_losses_positive(sample):
    _, _, obs, *_ = sample
    losses = loss_tree(obs)
    assert losses["kwh"].sum() > 0


def test_night_generation(sample):
    _, pv, *_ = sample
    night = pv["solar_elevation_deg"] <= 0
    assert pv.loc[night, "ac_power_kw"].abs().max() < 1e-6


def test_observed_derived_from_expected(sample):
    _, _, obs, *_ = sample
    assert (obs["measured_power_kw"] >= 0).all()
    assert obs["measured_power_kw"].sum() > 0.8 * obs["expected_power_kw"].sum()


def test_digital_twin_residuals(sample):
    _, _, obs, *_ = sample
    twin = compare_twin(obs)
    assert "relative_error_pct" in twin


def test_twin_metrics(sample):
    _, _, obs, *_ = sample
    metrics = twin_metrics(compare_twin(obs))
    assert metrics["rmse_kw"] >= metrics["mae_kw"]


def test_pr_manual_case(sample):
    _, _, obs, *_ = sample
    k = performance_kpis(obs)
    assert 0 < k["performance_ratio"] < 1


def test_loss_balance(sample):
    _, _, obs, *_ = sample
    losses = loss_tree(obs)
    assert math.isclose(losses["mwh"].sum() * 1000, losses["kwh"].sum())


def test_fault_ground_truth(sample):
    *_, faults, _ = sample
    assert len(faults) >= 10


def test_string_offline_reduces(sample):
    _, _, obs, *_ = sample
    assert (obs["measured_power_kw"] <= obs["expected_power_kw"] * 1.1).all()


def test_detection_metrics(sample):
    _, _, obs, faults, _ = sample
    _, metrics = detect_anomalies(compare_twin(obs), faults)
    assert set(metrics) == {"precision", "recall", "f1"}


def test_om_prioritization(sample):
    *_, faults, _ = sample
    om = om_events(faults)
    assert om.iloc[0]["priority_score"] >= om.iloc[-1]["priority_score"]


def test_soc_limits():
    pv = np.array([1000, 0, 0, 1000, 0], dtype=float)
    load = np.array([100, 800, 800, 100, 800], dtype=float)
    t = np.array([0.5, 1.0, 1.0, 0.5, 1.0])
    out = dispatch_bess(pv, load, t, BESS(power_kw=500, energy_kwh=1000), "self_consumption")
    assert out["soc_pct"].between(10, 90).all()


def test_charge_efficiency():
    out = dispatch_bess(np.array([1000.0]), np.array([0.0]), np.array([0.5]), BESS(power_kw=500, energy_kwh=1000), "self_consumption")
    assert out["bess_losses_kwh"].iloc[0] > 0


def test_discharge_efficiency():
    out = dispatch_bess(np.array([0.0]), np.array([400.0]), np.array([1.0]), BESS(power_kw=500, energy_kwh=1000), "self_consumption")
    assert out["discharge_energy_kwh"].iloc[0] > 0


def test_power_limits():
    out = dispatch_bess(np.array([5000.0, 0]), np.array([0.0, 5000]), np.array([0.5, 1.0]), BESS(power_kw=250, energy_kwh=1000), "self_consumption")
    assert out["charge_power_kw"].max() <= 250
    assert out["discharge_power_kw"].max() <= 250


def test_no_simultaneous_charge_discharge():
    out = dispatch_bess(np.ones(24) * 1000, np.ones(24) * 600, np.ones(24) * 0.6, BESS(), "optimized")
    assert ((out["charge_power_kw"] > 0) & (out["discharge_power_kw"] > 0)).sum() == 0


def test_energy_balance():
    out = dispatch_bess(np.array([1000.0, 0]), np.array([600.0, 600]), np.array([0.5, 1.0]), BESS(), "self_consumption")
    assert out["balance_error_kwh"].abs().max() < 1e-6


def test_peak_shaving():
    out = dispatch_bess(np.zeros(3), np.array([700.0, 950, 900]), np.ones(3), BESS(), "peak_shaving", 800)
    assert out["grid_import_kwh"].max() <= 800 + 1e-6


def test_self_consumption():
    out = dispatch_bess(np.array([800.0, 0]), np.array([300.0, 600]), np.array([0.5, 1.0]), BESS(), "self_consumption")
    assert out["charge_energy_kwh"].iloc[0] > 0


def test_arbitrage():
    out = dispatch_bess(np.array([0.0, 0]), np.array([0.0, 600]), np.array([0.2, 1.5]), BESS(), "arbitrage")
    assert out["charge_energy_kwh"].iloc[0] > 0


def test_optimizer_constraints():
    res = optimize_dispatch_linprog(np.zeros(5), np.ones(5) * 500, np.ones(5), BESS())
    assert res["success"]


def test_sizing_in_grid(sample):
    _, _, obs, _, load = sample
    table, best = optimize_bess_size(obs, load)
    assert (best["bess_kw"], best["bess_kwh"]) in list(zip(table["bess_kw"], table["bess_kwh"]))


@pytest.mark.parametrize("rate,cashflows,expected", [(0.1, [-100, 60, 60], -100 + 60/1.1 + 60/1.21), (0.0, [-10, 3, 4], -3)])
def test_npv(rate, cashflows, expected):
    assert npv(rate, cashflows) == pytest.approx(expected)


def test_irr():
    assert irr([-100, 60, 60]) == pytest.approx(0.1306, rel=1e-3)


def test_payback():
    assert payback([-100, 50, 60]) == pytest.approx(1.8333, rel=1e-3)


def test_discounted_payback():
    assert payback([-100, 60, 60], 0.1) > payback([-100, 60, 60], 0)


def test_economics_lcos(sample):
    _, _, obs, _, load = sample
    cfg = BESS()
    disp = dispatch_bess(obs["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariff_series(load["timestamp"]), cfg, "optimized")
    econ = annual_economics(obs, load, disp, cfg)
    assert econ["lcos_brl_kwh"] > 0


def test_degradation_cost(sample):
    _, _, obs, _, load = sample
    cfg = BESS()
    disp = dispatch_bess(obs["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariff_series(load["timestamp"]), cfg, "optimized")
    econ = annual_economics(obs, load, disp, cfg)
    assert econ["degradation_cost_brl_year"] >= 0


def test_api_models_validate():
    assert BESS(power_kw=250, energy_kwh=500).energy_kwh == 500


def test_bess_rejects_invalid_soc_limits():
    with pytest.raises(ValueError):
        BESS(soc_min_pct=60, soc_initial_pct=50, soc_max_pct=90)


def test_scenarios(sample):
    _, _, obs, _, load = sample
    sc = scenario_table(obs, load)
    assert len(sc) >= 9


def test_sensitivity(sample):
    _, _, obs, _, load = sample
    sens, tornado = sensitivity(obs, load)
    assert len(sens) >= 25
    assert not tornado.empty


@pytest.mark.parametrize("strategy", ["self_consumption", "peak_shaving", "arbitrage", "curtailment_recovery", "reserve_soc", "multi_objective", "optimized"])
def test_dispatch_strategies(strategy):
    pv = np.tile([0, 100, 800, 600, 0, 0], 4).astype(float)
    load = np.ones(len(pv)) * 500
    tariff = np.tile([0.4, 0.4, 0.5, 0.8, 1.1, 1.1], 4)
    out = dispatch_bess(pv, load, tariff, BESS(), strategy)
    assert out["balance_error_kwh"].abs().max() < 1e-6


@pytest.mark.parametrize("col", ["ghi_w_m2", "dni_w_m2", "dhi_w_m2", "temp_air_c", "wind_speed_m_s", "relative_humidity_pct", "cloud_cover_pct"])
def test_weather_columns(sample, col):
    w, *_ = sample
    assert col in w.columns


@pytest.mark.parametrize("col", ["poa_global_w_m2", "cell_temperature_c", "dc_power_kw", "ac_power_kw", "expected_power_kw", "measured_power_kw", "clipping_kwh", "curtailment_kwh"])
def test_pv_columns(sample, col):
    _, _, obs, *_ = sample
    assert col in obs.columns


@pytest.mark.parametrize("metric", ["annual_generation_kwh", "performance_ratio", "specific_yield_kwh_kwp", "capacity_factor", "availability"])
def test_kpi_columns(sample, metric):
    _, _, obs, *_ = sample
    assert metric in performance_kpis(obs)


@pytest.fixture(scope="session")
def generated_artifacts():
    results = write_outputs()
    save_figures()
    return results


def test_write_outputs_generates_portfolio_files(generated_artifacts):
    expected = [
        DATA / "portfolio" / "results.json",
        DATA / "portfolio" / "loss_tree.csv",
        DATA / "portfolio" / "bess_sizing.csv",
        DATA / "portfolio" / "pv_digital_twin.db",
    ]
    assert generated_artifacts["performance"]["annual_generation_kwh"] > 0
    assert all(path.exists() for path in expected)


def test_load_results_round_trip(generated_artifacts):
    loaded = load_results()
    assert loaded["plant"]["plant_id"] == generated_artifacts["plant"]["plant_id"]


def test_create_insights_returns_portfolio_narrative(generated_artifacts):
    insights = create_insights()
    assert len(insights) >= 10
    assert any("PR calculado" in item for item in insights)


def test_save_figures_generates_required_images(generated_artifacts):
    expected = [
        ROOT / "assets" / "screenshots" / "01_executive.png",
        ROOT / "assets" / "screenshots" / "04_performance.png",
        ROOT / "assets" / "architecture" / "system_architecture.png",
        ROOT / "assets" / "linkedin" / "capa_projeto_linkedin.png",
    ]
    assert all(path.exists() and path.stat().st_size > 1000 for path in expected)


def test_asset_hierarchy_shape():
    assets = asset_hierarchy()
    assert {"asset_id", "parent_id", "asset_type", "name"}.issubset(assets.columns)
    assert (assets["asset_type"] == "STRING").sum() == 96
    assert (assets["asset_type"] == "MPPT").sum() == 48


@pytest.mark.parametrize(
    "module_name",
    [
        "src.bess.degradation",
        "src.bess.dispatch",
        "src.bess.model",
        "src.bess.soc",
        "src.digital_twin.residuals",
        "src.digital_twin.twin",
        "src.digital_twin.validation",
        "src.economics.capex",
        "src.economics.cashflow",
        "src.economics.financial_metrics",
        "src.economics.lcos",
        "src.economics.opex",
        "src.faults.anomaly_detection",
        "src.faults.diagnostics",
        "src.faults.fault_injector",
        "src.om.prioritization",
        "src.om.work_orders",
        "src.optimization.heuristic",
        "src.optimization.optimizer",
        "src.optimization.sizing",
        "src.performance.availability",
        "src.performance.loss_tree",
        "src.performance.pr",
        "src.performance.yield_metrics",
        "src.reporting.reports",
        "src.scenarios.engine",
        "src.scenarios.sensitivity",
        "src.scenarios.what_if",
        "src.solar.inverter",
        "src.solar.losses",
        "src.solar.pv_model",
        "src.solar.resource",
        "src.solar.temperature",
        "src.solar.transposition",
        "src.validation.consistency",
        "src.validation.energy_balance",
    ],
)
def test_facade_modules_import(module_name):
    assert importlib.import_module(module_name)
