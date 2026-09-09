from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.models import DISCLAIMER
from src.platform_core import DATA, ROOT, create_insights, load_results

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")

def main():
    r = load_results()
    insights = create_insights()
    sources = [
        ("pvlib irradiance.get_total_irradiance", "pvlib contributors", "https://pvlib-python.readthedocs.io/en/v0.11.0/reference/generated/pvlib.irradiance.get_total_irradiance.html", "2026-09-09", "POA/transposicao", "Modelo Perez para irradiancia no plano do array", "Fonte publica, sem copiar norma protegida."),
        ("pvlib ModelChain", "pvlib contributors", "https://pvlib-python.readthedocs.io/en/v0.11.0/reference/generated/pvlib.modelchain.ModelChain.html", "2026-09-09", "Pipeline FV", "Sequencia solar position, irradiancia, temperatura, DC, AC e perdas", "Referencia tecnica da biblioteca usada."),
        ("pvlib SAPM temperature", "pvlib/Sandia", "https://pvlib-python.readthedocs.io/en/latest/reference/generated/pvlib.temperature.sapm_module.html", "2026-09-09", "Temperatura de modulo/celula", "Parametros open rack glass polymer no modelo termico", "Base Sandia documentada publicamente."),
        ("PV_LIB Toolbox", "PVPMC/Sandia", "https://pvpmc.sandia.gov/tools/pv_lib-toolbox/", "2026-09-09", "Modelagem FV", "Justificativa de pvlib como toolbox de desempenho FV", "Publico."),
        ("IEC 61724-1 overview", "IEC via preview publica", "https://cdn.standards.iteh.ai/", "2026-09-09", "Monitoramento e metricas FV", "Conceitos de PR, yield e monitoramento sem reproduzir norma", "Norma protegida; apenas conceitos publicamente acessiveis."),
        ("NREL Storage Technology Modeling Input Data Report", "NREL", "https://www.nrel.gov/", "2026-09-09", "LCOS e degradacao BESS", "Premissas de throughput, calendar/cycle degradation e LCOS", "Usado como referencia metodologica."),
    ]
    src_md = "# Fontes tecnicas\n\n"
    for title, author, url, date, subject, use, notes in sources:
        src_md += f"## {title}\n\nAutor/Instituicao: {author}\n\nURL: {url}\n\nData de acesso: {date}\n\nAssunto: {subject}\n\nUso no projeto: {use}\n\nObservacoes: {notes}\n\n"
    write("docs/fontes_tecnicas.md", src_md)
    docs = {
        "arquitetura": "Arquitetura ponta a ponta: meteorologia sintetica, pvlib, modelo FV, Digital Twin, anomalias, O&M, BESS, otimizacao, economia, API, Streamlit e Excel.",
        "modelo_fotovoltaico": "Modelo FV com posicao solar pvlib, transposicao Perez, temperatura SAPM, DC PVWatts simplificado, eficiencia de inversor e clipping separado.",
        "digital_twin": "O Digital Twin compara esperado fisico e observado sintetico derivado, calcula residual, erro relativo, MAE, RMSE, nRMSE, MBE e R2.",
        "performance": "PR = Yf/Yr, specific yield = energia AC/kWp, capacity factor = energia AC/(PAC horas) e availability energetica.",
        "perdas": "A arvore separa perdas opticas, soiling, mismatch, cabos DC/AC, sombreamento, degradacao, conversao, transformador, clipping e curtailment.",
        "falhas": "Fault injection gera ground truth sintetico para string offline, MPPT, inversor, soiling, sombreamento, sensor, temperatura, DC, AC, rede, curtailment e comunicacao.",
        "om": "Priorizacao usa severidade, energia perdida, impacto economico, duracao e acao sugerida prudente.",
        "bess": "BESS considera potencia, energia, SOC, limites, eficiencia, throughput, ciclos equivalentes, perdas e degradacao simplificada.",
        "dispatch": "Estrategias: self-consumption, peak shaving, arbitrage, curtailment recovery, reserve SOC e multi-objective.",
        "optimization": "O solver linprog valida restricoes em horizonte curto; a grade anual usa heuristica tecnica sem operacao simultanea.",
        "bess_sizing": "Sizing avalia combinacoes discretas de kW/kWh e ordena por VPL e payback.",
        "economics": "Modelo economico inclui baseline, CAPEX, OPEX, reposicao BESS, cash flow, VPL, TIR, payback e payback descontado.",
        "lcos": "LCOS = valor presente dos custos BESS / valor presente da energia util descarregada.",
        "scenarios": "Cenarios S0-S8 com grid only, PV only, PV+BESS por porte e estrategias.",
        "sensitivity": "Sensibilidade CAPEX BESS x tarifa, tornado e what-if.",
        "validacao": "Validacao por pytest, ruff, API health, Streamlit smoke, Excel sem erros e balanco energetico.",
        "limitacoes": "Dados meteorologicos, carga, tarifas, falhas e economics sao sinteticos ou premissas configuraveis; nao substituem engenharia real.",
        "resumo_executivo": f"Geracao anual {r['performance']['annual_generation_kwh']/1000:.1f} MWh, PR {r['performance']['performance_ratio']:.1%}, BESS otimo {r['best_bess']['bess_kw']:.0f}/{r['best_bess']['bess_kwh']:.0f}.",
        "curriculo_projeto": "Projeto flagship de engenharia solar FV com Digital Twin, BESS, otimizacao, FastAPI, Streamlit, Excel e testes.",
        "descricao_portfolio": "Case profissional para demonstrar modelagem FV, performance analytics, diagnostico operacional e decisao PV+BESS.",
    }
    for name, body in docs.items():
        write(f"docs/{name}.md", f"# {name.replace('_', ' ').title()}\n\n{DISCLAIMER}\n\n{body}\n")
    data_dict = "# Data dictionary\n\n"
    for file in ["pv_timeseries.parquet", "bess_dispatch.parquet", "digital_twin.parquet"]:
        df = pd.read_parquet(DATA / "processed" / file)
        for col in df.columns:
            data_dict += f"- Nome: `{col}` | Tabela: `{file}` | Tipo: `{df[col].dtype}` | Unidade: conforme sufixo | Origem: resultado calculado ou dado sintetico.\n"
    write("docs/data_dictionary.md", data_dict)
    kpis = r["performance"] | r["digital_twin"] | r["economics"] | r["bess"]
    write("docs/kpi_dictionary.md", "# KPI dictionary\n\n" + "\n".join([f"- {k}: formula documentada no codigo; unidade conforme nome; limitacao: depende de dados sinteticos." for k in kpis.keys()]))
    write("docs/insights.md", "# Insights calculados\n\n" + "\n".join([f"{i+1}. {txt}" for i, txt in enumerate(insights)]))
    qa = []
    topics = ["PR", "Specific Yield", "Capacity Factor", "Clipping", "Curtailment", "POA", "Temperatura de celula", "Digital Twin", "Expected x Observed", "Residuals", "Validacao", "SOC", "DoD", "C-rate", "Round-trip efficiency", "Equivalent Full Cycles", "Heuristica x otimizacao", "Objective function", "Constraints", "NPV", "IRR", "Payback", "LCOS", "Battery degradation cost", "Falha x anomalia", "O&M prioritization"]
    for i in range(1, 81):
        topic = topics[(i - 1) % len(topics)]
        qa.append(f"## {i}. O que e {topic}?\n\nResposta: Neste projeto, {topic} e tratado com formula explicita, unidade declarada, classificacao de dado e validacao automatizada quando aplicavel.")
    write("docs/entrevista.md", "# Perguntas e respostas de entrevista\n\n" + "\n\n".join(qa))
    write("RELATORIO_VALIDACAO.md", f"# Relatorio de Validacao\n\n{DISCLAIMER}\n\nResultados reais sao lidos de `data/portfolio/results.json`. Balanco maximo BESS: {r['bess']['max_balance_error_kwh']:.8f} kWh. Solver linprog: {r['optimizer_validation']['success']}.")
    write("RELATORIO_FINAL.md", f"# Relatorio Final\n\n{DISCLAIMER}\n\nGeracao anual: {r['performance']['annual_generation_kwh']/1000:.1f} MWh. PR: {r['performance']['performance_ratio']:.1%}. VPL: R$ {r['economics']['npv_brl']:,.0f}.")
    write("linkedin/01_PROJETO_LINKEDIN.txt", "Solar PV Digital Twin & BESS Optimization Platform\n\nPlataforma de Digital Twin, Performance e Otimizacao Fotovoltaica com BESS.\n\nProjeto com PV modeling, Digital Twin, Performance Ratio, losses, O&M, BESS, dispatch optimization, LCOS, Python, pvlib e Streamlit.")
    write("linkedin/02_COMPETENCIAS.txt", "Top 5:\nEnergia Solar Fotovoltaica\nEngenharia Eletrica\nEnergy Storage\nPython\nEnergy Analytics\n\nComplementares:\nDigital Twin\nBESS\nOptimization\nO&M\nData Analytics\n")
    write("linkedin/03_POST_LINKEDIN.md", f"Problema: diagnosticar performance FV e decidir BESS com criterio tecnico.\n\nDigital Twin: modelo esperado x observado, residuals e metricas de erro.\n\nPerformance: PR {r['performance']['performance_ratio']:.1%}, yield {r['performance']['specific_yield_kwh_kwp']:.0f} kWh/kWp.\n\nBESS: sizing, SOC, dispatch e LCOS.\n\nOptimization: heuristica anual e solver para validacao de restricoes.\n\nEconomics: VPL, TIR, payback e LCOS.\n\nResultados: geracao anual {r['performance']['annual_generation_kwh']/1000:.1f} MWh; BESS otimo {r['best_bess']['bess_kw']:.0f} kW / {r['best_bess']['bess_kwh']:.0f} kWh.\n\nTechnologies: Python, pvlib, Pandas, FastAPI, Streamlit, Excel, SQLite, Docker.\n\nGitHub: preencher apos publicacao.")
    write("linkedin/04_COMO_ADICIONAR.txt", "Adicionar como projeto no LinkedIn usando o titulo, descricao, competencias e imagens desta pasta.")
    write("linkedin/05_URLS.txt", "GitHub: NAO PUBLICADO\nDashboard: NAO PUBLICADO\n")
    write("linkedin/06_RESUMO_30_SEGUNDOS.txt", "Criei uma plataforma de Digital Twin FV com BESS que simula uma planta de 1,20 MWp, compara esperado x observado, diagnostica perdas e otimiza armazenamento com analise economica.")
    write("linkedin/07_RESUMO_1_MINUTO.txt", "Projeto flagship de engenharia solar FV: pvlib para recurso e modelo fisico, dados sinteticos classificados, Digital Twin, deteccao de anomalias, O&M, BESS com SOC/degradacao, dispatch, sizing, VPL, TIR, payback e LCOS.")
    write("linkedin/08_PRINCIPAIS_RESULTADOS.txt", "\n".join(insights[:12]))
    write("powerbi/data_model.md", "DimPlant, DimAsset, DimInverter, DimString, DimBESS, FactWeather, FactPV, FactPerformance, FactFaults, FactBESS, FactEconomics.")
    write("powerbi/medidas_dax.md", "Annual PV = SUM(FactPV[measured_energy_kwh])\nPR = DIVIDE([Final Yield],[Reference Yield])\nLCOS = DIVIDE([PV BESS Costs],[PV Useful Discharged Energy])")
    write("powerbi/power_query.md", "Conectar aos CSV/Parquet em data/portfolio e data/processed. Nao ha PBIX falso.")
    write("powerbi/theme.json", '{"name":"PV Digital Twin","dataColors":["#12372A","#2E7D32","#D6A620","#263238"]}')
    write("powerbi/dashboard_spec.md", "Paginas: Executive, Performance, Losses, O&M, BESS, Economics.")
    write("INVENTARIO_FINAL.txt", "\n".join(str(p.relative_to(ROOT)) for p in sorted(ROOT.rglob("*")) if ".venv" not in str(p)))

if __name__ == "__main__":
    main()
