from __future__ import annotations

import pandas as pd
import plotly.express as px
import streamlit as st

from src.models import DISCLAIMER
from src.platform_core import DATA, load_results

st.set_page_config(page_title="PV Digital Twin & BESS Platform", layout="wide")
st.markdown("<style>body{color:#263238}.stApp{background:#F8FAF7}.metric-card{background:white;border-left:4px solid #2E7D32;padding:10px}</style>", unsafe_allow_html=True)
r = load_results()
st.sidebar.title("PV Digital Twin & BESS")
page = st.sidebar.radio("Pagina", [
    "Visao Executiva", "Digital Twin", "Recurso Solar & Modelo FV", "PV Performance",
    "Loss Analysis", "Strings & Inverters", "Fault & Anomaly Detection", "O&M Intelligence",
    "BESS Operation", "Dispatch Optimization", "PV + BESS Energy Balance",
    "Techno-Economic Analysis", "Scenario Comparison", "Sensitivity & What-if",
    "Methodology & Data",
])
st.caption(DISCLAIMER)
pv = pd.read_parquet(DATA / "processed" / "pv_timeseries.parquet")
bess = pd.read_parquet(DATA / "processed" / "bess_dispatch.parquet")
if page == "Visao Executiva":
    cols = st.columns(5)
    metrics = [
        ("PV DC", f"{r['plant']['dc_capacity_kwp']/1000:.2f} MWp"),
        ("PV AC", f"{r['plant']['ac_capacity_kw']/1000:.2f} MW"),
        ("BESS", f"{r['best_bess']['bess_kw']:.0f} kW / {r['best_bess']['bess_kwh']:.0f} kWh"),
        ("Geracao anual", f"{r['performance']['annual_generation_kwh']/1000:.1f} MWh"),
        ("PR", f"{r['performance']['performance_ratio']:.1%}"),
        ("Specific Yield", f"{r['performance']['specific_yield_kwh_kwp']:.0f} kWh/kWp"),
        ("Availability", f"{r['performance']['availability']:.1%}"),
        ("Self-Consumption", f"{r['bess']['self_consumption_after_pct']:.1%}"),
        ("Peak Reduction", f"{r['bess']['peak_reduction_kw']:.1f} kW"),
        ("NPV", f"R$ {r['economics']['npv_brl']/1e6:.2f}M"),
    ]
    for i, (k, v) in enumerate(metrics):
        cols[i % 5].metric(k, v)
    st.plotly_chart(px.line(pv.iloc[:720], x="timestamp", y=["expected_power_kw", "measured_power_kw"], title="Expected x Observed"), use_container_width=True)
elif page == "Digital Twin":
    st.plotly_chart(px.scatter(pv.sample(1500, random_state=2), x="expected_power_kw", y="measured_power_kw", color="relative_error_pct", title="Expected vs Observed"), use_container_width=True)
    st.plotly_chart(px.histogram(pv, x="relative_error_pct", nbins=80, title="Residual distribution"), use_container_width=True)
elif page == "Loss Analysis":
    losses = pd.read_csv(DATA / "portfolio" / "loss_tree.csv")
    st.plotly_chart(px.bar(losses, x="mwh", y="loss", orientation="h", title="Loss ranking"), use_container_width=True)
    st.dataframe(losses, use_container_width=True)
elif page == "Strings & Inverters":
    st.dataframe(pd.read_csv(DATA / "portfolio" / "strings.csv"), use_container_width=True)
elif page == "Fault & Anomaly Detection":
    st.dataframe(pd.read_csv(DATA / "portfolio" / "fault_ground_truth.csv"), use_container_width=True)
    an = pd.read_parquet(DATA / "processed" / "anomalies.parquet")
    st.plotly_chart(px.line(an.iloc[:2000], x="timestamp", y="rolling_z_score", title="Rolling z-score"), use_container_width=True)
elif page == "O&M Intelligence":
    st.dataframe(pd.read_csv(DATA / "portfolio" / "om_events.csv"), use_container_width=True)
elif page in ["BESS Operation", "Dispatch Optimization", "PV + BESS Energy Balance"]:
    st.plotly_chart(px.line(bess.iloc[:720], x="timestamp", y=["soc_pct", "charge_power_kw", "discharge_power_kw", "grid_import_kwh", "grid_export_kwh"], title=page), use_container_width=True)
    st.metric("Max balance error", f"{r['bess']['max_balance_error_kwh']:.6f} kWh")
elif page == "Techno-Economic Analysis":
    st.json(r["economics"])
    sc = pd.read_csv(DATA / "portfolio" / "scenarios.csv")
    st.plotly_chart(px.bar(sc, x="scenario", y="npv_brl", title="NPV by scenario"), use_container_width=True)
elif page == "Scenario Comparison":
    st.dataframe(pd.read_csv(DATA / "portfolio" / "scenarios.csv"), use_container_width=True)
elif page == "Sensitivity & What-if":
    sens = pd.read_csv(DATA / "portfolio" / "sensitivity.csv")
    st.plotly_chart(px.density_heatmap(sens, x="tariff_delta_pct", y="capex_bess_delta_pct", z="npv_brl", title="CAPEX BESS x Tarifa"), use_container_width=True)
else:
    st.write("Dados classificados como sinteticos, premissas configuraveis e resultados calculados.")
    st.code("docs/fontes_tecnicas.md")
    st.dataframe(pd.read_yaml(DATA / "data_catalog.yaml") if hasattr(pd, "read_yaml") else pd.DataFrame())
