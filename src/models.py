from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

DISCLAIMER = (
    "Este projeto e uma plataforma educacional e analitica de portfolio. "
    "Os resultados nao substituem projeto executivo, estudo de conexao, "
    "engenharia de protecao, especificacao de fabricante, estudo de seguranca, "
    "analise de incendio, projeto de BESS ou avaliacao financeira real."
)


@dataclass(frozen=True)
class PVModule:
    pmp_w: float = 535.0
    voc_v: float = 49.5
    isc_a: float = 13.7
    vmp_v: float = 41.8
    imp_a: float = 12.8
    gamma_pdc_per_c: float = -0.0035
    source: str = "premissa configuravel baseada em modulo generico"


@dataclass(frozen=True)
class Inverter:
    inverter_id: str
    ac_capacity_kw: float = 250.0
    dc_max_kw: float = 330.0
    mppt_count: int = 12
    max_voltage_v: float = 1100.0
    mppt_min_voltage_v: float = 500.0
    mppt_max_voltage_v: float = 850.0
    efficiency_pct: float = 98.5


@dataclass(frozen=True)
class PVPlant:
    plant_id: str = "PLANT-NEXUS-SOLAR-001"
    name: str = "NEXUS SOLAR INDUSTRIAL PLANT"
    country: str = "Brasil"
    city_reference: str = "Campinas, SP"
    latitude: float = -22.9056
    longitude: float = -47.0608
    altitude_m: float = 650.0
    timezone: str = "America/Sao_Paulo"
    dc_capacity_kwp: float = 1200.54
    ac_capacity_kw: float = 1000.0
    modules: int = 2244
    modules_per_string: int = 22
    tilt_deg: float = 22.0
    azimuth_deg: float = 0.0
    albedo: float = 0.2
    inverters: tuple[Inverter, ...] = field(
        default_factory=lambda: tuple(
            Inverter(inverter_id=f"INV-{i:02d}") for i in range(1, 5)
        )
    )

    @property
    def strings(self) -> int:
        return self.modules // self.modules_per_string

    @property
    def dc_ac_ratio(self) -> float:
        return self.dc_capacity_kwp / self.ac_capacity_kw


@dataclass(frozen=True)
class BESS:
    power_kw: float = 500.0
    energy_kwh: float = 1000.0
    soc_initial_pct: float = 50.0
    soc_min_pct: float = 10.0
    soc_max_pct: float = 90.0
    charge_efficiency: float = 0.95
    discharge_efficiency: float = 0.95
    c_rate: float = 0.5
    reserve_soc_pct: float = 20.0
    auxiliary_kw: float = 2.0
    calendar_degradation_pct_per_year: float = 1.0
    cycle_degradation_pct_per_efc: float = 0.004

    def __post_init__(self) -> None:
        if not (0 <= self.soc_min_pct < self.soc_initial_pct < self.soc_max_pct <= 100):
            raise ValueError("SOC limits must satisfy min < initial < max.")


class BESSRequest(BaseModel):
    strategy: Literal[
        "self_consumption",
        "peak_shaving",
        "arbitrage",
        "curtailment_recovery",
        "reserve_soc",
        "multi_objective",
        "optimized",
    ] = "optimized"
    power_kw: float = Field(default=500, gt=0, le=5000)
    energy_kwh: float = Field(default=1000, gt=0, le=20000)
    reserve_soc_pct: float = Field(default=20, ge=0, le=80)
    peak_target_kw: float = Field(default=850, gt=0)


class ScenarioRequest(BaseModel):
    name: str = "PV + BESS Optimized"
    bess_power_kw: float = Field(default=500, ge=0)
    bess_energy_kwh: float = Field(default=1000, ge=0)
    strategy: str = "optimized"


class WhatIfRequest(BaseModel):
    battery_capex_delta_pct: float = 0.0
    tariff_delta_pct: float = 0.0
    pv_size_delta_pct: float = 0.0
    load_growth_pct: float = 0.0
    degradation_delta_pct: float = 0.0
