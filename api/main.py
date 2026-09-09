from __future__ import annotations

import pandas as pd
from fastapi import FastAPI, HTTPException

from src.models import BESS, DISCLAIMER, BESSRequest, ScenarioRequest, WhatIfRequest
from src.platform_core import (
    DATA,
    annual_economics,
    asset_hierarchy,
    dispatch_bess,
    load_results,
    optimize_bess_size,
    scenario_table,
    tariff_series,
)

app = FastAPI(title="Solar PV Digital Twin & BESS Optimization Platform")

def pv_load():
    pv = pd.read_parquet(DATA / "processed" / "pv_timeseries.parquet")
    load = pd.read_parquet(DATA / "processed" / "load.parquet")
    return pv, load

@app.get("/health")
def health():
    return {"status": "ok", "disclaimer": DISCLAIMER}

@app.get("/plant")
def plant():
    return load_results()["plant"]

@app.get("/plant/kpis")
def plant_kpis():
    return load_results()["performance"]

@app.get("/plant/performance")
def plant_performance():
    return load_results()["performance"]

@app.get("/assets")
def assets():
    return asset_hierarchy().to_dict(orient="records")

@app.get("/assets/{asset_id}")
def asset(asset_id: str):
    rows = asset_hierarchy()
    hit = rows[rows["asset_id"] == asset_id]
    if hit.empty:
        raise HTTPException(status_code=404, detail="Asset not found")
    return hit.iloc[0].to_dict()

@app.get("/losses")
def losses():
    return pd.read_csv(DATA / "portfolio" / "loss_tree.csv").to_dict(orient="records")

@app.get("/faults")
def faults():
    return pd.read_csv(DATA / "portfolio" / "fault_ground_truth.csv").to_dict(orient="records")

@app.get("/om/events")
def om_events():
    return pd.read_csv(DATA / "portfolio" / "om_events.csv").to_dict(orient="records")

@app.get("/bess/status")
def bess_status():
    r = load_results()["bess"]
    return r

@app.post("/bess/simulate")
def bess_simulate(req: BESSRequest):
    pv, load = pv_load()
    cfg = BESS(power_kw=req.power_kw, energy_kwh=req.energy_kwh, reserve_soc_pct=req.reserve_soc_pct)
    out = dispatch_bess(pv["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariff_series(load["timestamp"]), cfg, req.strategy, req.peak_target_kw)
    return {"rows": len(out), "summary": {"peak_kw": float(out["grid_import_kwh"].max()), "throughput_kwh": float(out["throughput_kwh"].sum())}}

@app.post("/bess/optimize")
def bess_optimize(req: BESSRequest):
    pv, load = pv_load()
    table, best = optimize_bess_size(pv, load)
    return {"best": best, "tested": len(table)}

@app.post("/bess/size")
def bess_size(req: BESSRequest):
    pv, load = pv_load()
    table, best = optimize_bess_size(pv, load)
    return {"best": best, "grid": table.to_dict(orient="records")}

@app.post("/scenario/run")
def scenario_run(req: ScenarioRequest):
    pv, load = pv_load()
    return scenario_table(pv, load).to_dict(orient="records")

@app.post("/what-if")
def what_if(req: WhatIfRequest):
    pv, load = pv_load()
    cfg = BESS()
    disp = dispatch_bess(pv["measured_energy_kwh"].to_numpy(), load["load_kwh"].to_numpy(), tariff_series(load["timestamp"], 1 + req.tariff_delta_pct / 100), cfg, "optimized")
    return annual_economics(pv, load, disp, cfg, req.battery_capex_delta_pct, req.tariff_delta_pct)

@app.get("/economics")
def economics():
    return load_results()["economics"]

@app.get("/lcos")
def lcos():
    return {"lcos_brl_kwh": load_results()["economics"]["lcos_brl_kwh"]}
