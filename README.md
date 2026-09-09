# Solar PV Digital Twin & BESS Optimization Platform

Digital Twin - Performance - O&M - BESS - Optimization - Python

Este projeto e uma plataforma educacional e analitica de portfolio. Os resultados nao substituem projeto executivo, estudo de conexao, engenharia de protecao, especificacao de fabricante, estudo de seguranca, analise de incendio, projeto de BESS ou avaliacao financeira real.

## Visao Geral

Plataforma local-first para modelagem fisica de uma planta FV, geracao esperada, dados observados sinteticos derivados do modelo, Digital Twin, performance analytics, perdas, falhas, O&M, BESS, despacho, otimizacao, sizing, economia, LCOS, cenarios, sensibilidade, FastAPI, Streamlit, Excel e pacote LinkedIn.

## Problema

Plantas FV reais precisam separar recurso solar, modelo esperado, degradacao, clipping, curtailment, disponibilidade, falhas e decisao economica. Este projeto demonstra esse fluxo com dados sinteticos classificados e calculos reproduziveis.

## Objetivo

Demonstrar competencia em Engenharia Eletrica, Energia Solar Fotovoltaica, Digital Twin, BESS, Energy Analytics, O&M, Python, pvlib, Pandas, otimizacao, FastAPI, Streamlit, Excel, SQL, Docker e testes.

## Arquitetura

Dados meteorologicos -> modelo fisico FV -> geracao esperada -> Digital Twin -> esperado x observado -> performance -> perdas/falhas/O&M -> balanco energetico -> BESS -> otimizacao -> economia -> decisao.

## How to Run

```powershell
.venv\Scripts\python.exe scripts\run_all.py
.venv\Scripts\python.exe scripts\build_excel.py
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m uvicorn api.main:app --reload
.venv\Scripts\python.exe -m streamlit run dashboard/streamlit_app.py
```

## Secoes

PV Modeling, Digital Twin, Performance Analytics, Loss Analysis, Fault Detection, O&M Intelligence, BESS, Dispatch, Optimization, BESS Sizing, Economic Analysis, LCOS, Scenarios, Sensitivity, Streamlit, FastAPI, Excel, Power BI, Tests, Methodology, Limitations, Roadmap e Autor estao documentados em `docs/`.

## Limitations

Weather, load, tariffs and faults are synthetic. Module, inverter, CAPEX and tariff values are configurable assumptions. No synthetic dataset is presented as real measurement.

## Autor

Portfolio project generated for Lucas.
