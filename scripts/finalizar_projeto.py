from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.platform_core import ROOT, load_results, save_figures, write_outputs

def run(cmd: list[str], timeout: int = 120) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    return p.returncode, p.stdout


def write_validation_report(validation: dict[str, str | int]) -> None:
    status = "APROVADO" if all(validation[key] == 0 for key in ["pytest_code", "ruff_code", "api_code", "streamlit_code"]) else "REPROVADO"
    body = f"""# Relatorio de Validacao

Status final: {status}

## Checks executados
- Pytest + coverage: exit code {validation["pytest_code"]}
- Ruff: exit code {validation["ruff_code"]}
- FastAPI `/health`: exit code {validation["api_code"]}
- Streamlit HTTP smoke: exit code {validation["streamlit_code"]}

## Evidencias

### Pytest
```text
{validation["pytest_output"]}
```

### Ruff
```text
{validation["ruff_output"]}
```

### API
```text
{validation["api_output"]}
```

### Streamlit
```text
{validation["streamlit_output"]}
```
"""
    (ROOT / "RELATORIO_VALIDACAO.md").write_text(body, encoding="utf-8")


def main():
    write_outputs()
    save_figures()
    run([sys.executable, "scripts/build_reports.py"])
    run([sys.executable, "scripts/build_excel.py"])
    tests_code, tests_out = run([sys.executable, "-m", "pytest"], timeout=240)
    ruff_code, ruff_out = run([sys.executable, "-m", "ruff", "check", "src", "api", "scripts"], timeout=120)
    api_proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "8000"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(4)
    api_code, api_out = run([sys.executable, "-c", "import requests; print(requests.get('http://127.0.0.1:8000/health', timeout=10).json())"], timeout=30)
    api_proc.terminate()
    stream_proc = subprocess.Popen([sys.executable, "-m", "streamlit", "run", "dashboard/streamlit_app.py", "--server.headless=true", "--server.port=8501"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(8)
    stream_code, stream_out = run([sys.executable, "-c", "import requests; r=requests.get('http://127.0.0.1:8501', timeout=10); print(r.status_code)"], timeout=30)
    stream_proc.terminate()
    validation = {
        "pytest_code": tests_code,
        "pytest_output": tests_out[-4000:],
        "ruff_code": ruff_code,
        "ruff_output": ruff_out[-4000:],
        "api_code": api_code,
        "api_output": api_out,
        "streamlit_code": stream_code,
        "streamlit_output": stream_out,
    }
    (ROOT / "data/portfolio/validation_run.json").write_text(json.dumps(validation, indent=2), encoding="utf-8")
    write_validation_report(validation)
    if any(validation[key] != 0 for key in ["pytest_code", "ruff_code", "api_code", "streamlit_code"]):
        raise RuntimeError("Validacao falhou; pacote final nao sera publicado.")
    outputs = ROOT / "outputs"
    outputs.mkdir(exist_ok=True)
    zip_path = outputs / "solar-pv-digital-twin-bess-platform-FINAL-PTBR.zip"
    skip = {".venv", ".git", "__pycache__", ".pytest_cache", ".ruff_cache"}
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in ROOT.rglob("*"):
            if any(part in skip for part in p.parts):
                continue
            if p.is_file() and p != zip_path:
                zf.write(p, p.relative_to(ROOT))
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    (outputs / "solar-pv-digital-twin-bess-platform-FINAL-PTBR.zip.sha256").write_text(digest, encoding="utf-8")
    shutil.copy2(ROOT / "RELATORIO_FINAL.md", outputs / "RELATORIO_FINAL.md")
    shutil.copy2(ROOT / "RELATORIO_VALIDACAO.md", outputs / "RELATORIO_VALIDACAO.md")
    results = load_results()
    results["validation"] = validation
    results["zip"] = str(zip_path)
    results["sha256"] = digest
    results["github_url"] = "https://github.com/luscaarmstrong1/solar-pv-digital-twin-bess-platform"
    (ROOT / "data/portfolio/final_summary.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(results, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
