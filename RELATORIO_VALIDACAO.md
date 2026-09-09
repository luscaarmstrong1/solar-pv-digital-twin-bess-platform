# Relatorio de Validacao

Status final: APROVADO

## Checks executados
- Pytest + coverage: exit code 0
- Ruff: exit code 0
- FastAPI `/health`: exit code 0
- Streamlit HTTP smoke: exit code 0

## Evidencias

### Pytest
```text
========================
tests/test_platform.py::test_write_outputs_generates_portfolio_files
  C:\Users\lucas\Documents\Codex\2026-09-09\ap-2\src\platform_core.py:960: UserWarning: Converting to PeriodArray/Index representation will drop timezone information.
    fig("assets/screenshots/04_performance.png", "Monthly PV Energy", lambda ax: pv.assign(month=pd.to_datetime(pv["timestamp"]).dt.to_period("M").astype(str)).groupby("month")["measured_energy_kwh"].sum().plot(kind="bar", ax=ax, color=colors[1]))

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=============================== tests coverage ================================
______________ coverage: platform win32, python 3.12.10-final-0 _______________

Name                                 Stmts   Miss  Cover   Missing
------------------------------------------------------------------
src\__init__.py                          0      0   100%
src\bess\__init__.py                     0      0   100%
src\bess\degradation.py                  1      0   100%
src\bess\dispatch.py                     1      0   100%
src\bess\model.py                        2      0   100%
src\bess\soc.py                          1      0   100%
src\digital_twin\__init__.py             0      0   100%
src\digital_twin\residuals.py            1      0   100%
src\digital_twin\twin.py                 1      0   100%
src\digital_twin\validation.py           1      0   100%
src\economics\__init__.py                0      0   100%
src\economics\capex.py                   1      0   100%
src\economics\cashflow.py                1      0   100%
src\economics\financial_metrics.py       1      0   100%
src\economics\lcos.py                    1      0   100%
src\economics\opex.py                    1      0   100%
src\faults\__init__.py                   0      0   100%
src\faults\anomaly_detection.py          1      0   100%
src\faults\diagnostics.py                1      0   100%
src\faults\fault_injector.py             1      0   100%
src\models.py                           82      0   100%
src\om\__init__.py                       0      0   100%
src\om\prioritization.py                 1      0   100%
src\om\work_orders.py                    1      0   100%
src\optimization\__init__.py             0      0   100%
src\optimization\heuristic.py            1      0   100%
src\optimization\optimizer.py            1      0   100%
src\optimization\sizing.py               1      0   100%
src\performance\__init__.py              0      0   100%
src\performance\availability.py          1      0   100%
src\performance\loss_tree.py             1      0   100%
src\performance\pr.py                    1      0   100%
src\performance\yield_metrics.py         1      0   100%
src\platform_core.py                   617      5    99%   34-37, 887
src\reporting\__init__.py                0      0   100%
src\reporting\reports.py                 1      0   100%
src\scenarios\__init__.py                0      0   100%
src\scenarios\engine.py                  1      0   100%
src\scenarios\sensitivity.py             1      0   100%
src\scenarios\what_if.py                 1      0   100%
src\solar\__init__.py                    0      0   100%
src\solar\inverter.py                    1      0   100%
src\solar\losses.py                      1      0   100%
src\solar\pv_model.py                    1      0   100%
src\solar\resource.py                    1      0   100%
src\solar\temperature.py                 1      0   100%
src\solar\transposition.py               1      0   100%
src\validation\__init__.py               0      0   100%
src\validation\consistency.py            1      0   100%
src\validation\energy_balance.py         1      0   100%
------------------------------------------------------------------
TOTAL                                  736      5    99%
Coverage XML written to file coverage.xml
Required test coverage of 80% reached. Total coverage: 99.32%
106 passed, 1 warning in 16.22s

```

### Ruff
```text
All checks passed!

```

### API
```text
{'status': 'ok', 'disclaimer': 'Este projeto e uma plataforma educacional e analitica de portfolio. Os resultados nao substituem projeto executivo, estudo de conexao, engenharia de protecao, especificacao de fabricante, estudo de seguranca, analise de incendio, projeto de BESS ou avaliacao financeira real.'}

```

### Streamlit
```text
200

```
