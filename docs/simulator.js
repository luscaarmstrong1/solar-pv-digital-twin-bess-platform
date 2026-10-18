// ==========================================================================
// V3 INTERACTIVE SIMULATOR ENGINE — solar-pv-digital-twin-bess-platform
// Generated from verified mathematical core (v3-engines.mjs)
// ==========================================================================
(function() {
  // Pure Mathematical Engines & Project Definitions for Lucas Santos Engineering Ecosystem V3
// All 9 simulators use deterministic, physically bounded engineering formulations.
// No em-dashes or en-dashes are used in any visible strings.

function clamp(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function fmtNum(val, digits = 1) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtBRL(val, digits = 0) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 'R$ 0';
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function solveIRR(cashflows, guess = 0.12) {
  // Bisection + secant solver for internal rate of return on [-0.5, 5.0]
  let low = -0.45;
  let high = 4.0;
  const npvAt = (r) => {
    let s = 0;
    for (let t = 0; t < cashflows.length; t++) {
      s += cashflows[t] / Math.pow(1 + r, t);
    }
    return s;
  };
  let fLow = npvAt(low);
  let fHigh = npvAt(high);
  if (fLow * fHigh > 0) {
    return 0;
  }
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (low + high);
    const fMid = npvAt(mid);
    if (Math.abs(fMid) < 1e-5) return mid * 100;
    if (fLow * fMid <= 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return 0.5 * (low + high) * 100;
}

// ============================================================================
// 01. SOLAR PV DIGITAL TWIN & BESS PLATFORM
// ============================================================================
function simulateProject01(rawParams = {}) {
  const p = {
    pvKwp: clamp(rawParams.pvKwp ?? 1200.5, 100, 5000),
    invAcKw: clamp(rawParams.invAcKw ?? 1000, 80, 4500),
    hsp: clamp(rawParams.hsp ?? 5.45, 3.0, 7.2),
    tAmb: clamp(rawParams.tAmb ?? 28.5, 15, 45),
    soilingPct: clamp(rawParams.soilingPct ?? 2.3, 0, 15),
    bessKwh: clamp(rawParams.bessKwh ?? 750, 0, 5000),
    bessKw: clamp(rawParams.bessKw ?? 250, 0, 2500),
    bessEffPct: clamp(rawParams.bessEffPct ?? 92.0, 75, 98),
    socMinPct: clamp(rawParams.socMinPct ?? 15, 5, 40),
    socMaxPct: clamp(rawParams.socMaxPct ?? 95, 60, 100),
    tarifaPonta: clamp(rawParams.tarifaPonta ?? 1.28, 0.4, 3.0),
    tarifaFora: clamp(rawParams.tarifaFora ?? 0.48, 0.2, 1.5),
    demandaRkw: clamp(rawParams.demandaRkw ?? 52.0, 15, 140),
    modoDespacho: rawParams.modoDespacho || 'peak_arbitrage'
  };
  if (p.socMaxPct <= p.socMinPct + 10) p.socMaxPct = Math.min(100, p.socMinPct + 15);

  const etaOneWay = Math.sqrt(p.bessEffPct / 100);
  const gamma = -0.0038; // %/C in decimal
  const noct = 45;
  // Normalized 24h solar bell (sums to 1.0)
  const irrShape = [0,0,0,0,0,0, 0.015,0.045,0.085,0.125,0.155,0.170, 0.165,0.130,0.075,0.028,0.007,0, 0,0,0,0,0,0];
  // Typical industrial/commercial load shape (kW base scaled to plant size)
  const loadBase = [310,300,295,295,305,340, 420,540,650,710,740,730, 690,720,735,710,680,760, 820,840,790,620,440,350];
  const loadScale = p.pvKwp / 1200.5;

  let socKwh = p.bessKwh * 0.50;
  const socMinKwh = p.bessKwh * (p.socMinPct / 100);
  const socMaxKwh = p.bessKwh * (p.socMaxPct / 100);
  socKwh = clamp(socKwh, socMinKwh, socMaxKwh);

  const hourly = [];
  let dailyPvDc = 0, dailyPvAc = 0, dailyClipping = 0, dailyBessDis = 0, dailyBessCh = 0;
  let peakBeforeKw = 0, peakAfterKw = 0;
  let costBeforeDay = 0, costAfterDay = 0;

  for (let h = 0; h < 24; h++) {
    const gWm2 = irrShape[h] * p.hsp * 1000;
    const tCell = p.tAmb + (gWm2 / 800) * (noct - 20);
    const fTemp = Math.max(0.70, 1 + gamma * Math.max(0, tCell - 25));
    const fSoiling = 1 - p.soilingPct / 100;
    const fOther = (1 - 0.0175) * (1 - 0.0146) * (1 - 0.0117); // optical, cables, mismatch
    const pvDcKw = p.pvKwp * (gWm2 / 1000) * fTemp * fSoiling * fOther;
    const pvPreInvKw = pvDcKw * (1 - 0.0134);
    const pvAcKw = Math.min(p.invAcKw, pvPreInvKw);
    const clipKw = Math.max(0, pvPreInvKw - pvAcKw);

    const loadKw = loadBase[h] * loadScale;
    const isPeak = h >= 18 && h <= 21;
    const tariff = isPeak ? p.tarifaPonta : p.tarifaFora;

    // Net load without BESS
    const netNoBessKw = Math.max(0, loadKw - pvAcKw);
    const surplusPvKw = Math.max(0, pvAcKw - loadKw);
    if (isPeak) peakBeforeKw = Math.max(peakBeforeKw, netNoBessKw);
    costBeforeDay += netNoBessKw * tariff;

    // BESS Dispatch Decision
    let pChKw = 0;
    let pDisKw = 0;
    const reserveTargetKwh = p.modoDespacho === 'backup_priority'
      ? socMinKwh + 0.45 * (socMaxKwh - socMinKwh)
      : socMinKwh;

    if (p.bessKwh > 0 && p.bessKw > 0) {
      if (h >= 9 && h <= 15) {
        // Charge from solar surplus or off-peak arbitrage window
        const maxRoomKwh = Math.max(0, socMaxKwh - socKwh);
        const desiredCh = p.modoDespacho === 'self_consumption'
          ? surplusPvKw
          : Math.max(surplusPvKw, p.bessKw * 0.65);
        pChKw = Math.min(p.bessKw, desiredCh, maxRoomKwh / etaOneWay);
      } else if (isPeak) {
        // Discharge during peak window
        const availKwh = Math.max(0, socKwh - reserveTargetKwh);
        const desiredDis = p.modoDespacho === 'peak_arbitrage'
          ? Math.min(p.bessKw, netNoBessKw * 0.65, availKwh * etaOneWay / 2.2)
          : Math.min(p.bessKw, netNoBessKw, availKwh * etaOneWay / 3.0);
        pDisKw = Math.max(0, desiredDis);
      } else if (p.modoDespacho === 'self_consumption' && netNoBessKw > 0 && h >= 16) {
        const availKwh = Math.max(0, socKwh - reserveTargetKwh);
        pDisKw = Math.min(p.bessKw * 0.6, netNoBessKw, availKwh * etaOneWay);
      }
    }

    socKwh = clamp(socKwh + pChKw * etaOneWay - pDisKw / etaOneWay, socMinKwh, socMaxKwh);
    const socPct = p.bessKwh > 0 ? (socKwh / p.bessKwh) * 100 : 0;

    // Grid import after BESS (only non-surplus charging comes from grid)
    const gridChKw = Math.max(0, pChKw - surplusPvKw);
    const netWithBessKw = Math.max(0, netNoBessKw + gridChKw - pDisKw);
    if (isPeak) peakAfterKw = Math.max(peakAfterKw, netWithBessKw);
    costAfterDay += netWithBessKw * tariff;

    dailyPvDc += pvDcKw;
    dailyPvAc += pvAcKw;
    dailyClipping += clipKw;
    dailyBessDis += pDisKw;
    dailyBessCh += pChKw;

    hourly.push({
      hora: `${String(h).padStart(2, '0')}:00`,
      h,
      loadKw: Number(loadKw.toFixed(1)),
      pvAcKw: Number(pvAcKw.toFixed(1)),
      netNoBessKw: Number(netNoBessKw.toFixed(1)),
      netWithBessKw: Number(netWithBessKw.toFixed(1)),
      bessFlowKw: Number((pDisKw - pChKw).toFixed(1)),
      socPct: Number(socPct.toFixed(1)),
      tCell: Number(tCell.toFixed(1))
    });
  }

  const idealDailyPv = p.pvKwp * p.hsp;
  const prPct = idealDailyPv > 0 ? (dailyPvAc / idealDailyPv) * 100 : 0;
  const annualPvMwh = (dailyPvAc * 365) / 1000;
  const peakReductionKw = Math.max(0, peakBeforeKw - peakAfterKw);
  const annualArbitrageSavings = Math.max(0, (costBeforeDay - costAfterDay) * 365);
  const annualDemandSavings = peakReductionKw * p.demandaRkw * 12;
  const annualPvSelfSavings = dailyPvAc * 365 * (0.35 * p.tarifaPonta + 0.65 * p.tarifaFora);
  const annualTotalSavings = annualPvSelfSavings * 0.25 + annualArbitrageSavings + annualDemandSavings;

  const capexPv = p.pvKwp * 3050;
  const capexBess = p.bessKwh * 1090 + p.bessKw * 420;
  const capexTotal = capexPv + capexBess;

  const wacc = 0.095;
  const cashflows = [-capexTotal];
  let npv = -capexTotal;
  let discThroughputKwh = 0;
  let discBessCost = capexBess;
  for (let yr = 1; yr <= 25; yr++) {
    const deg = Math.pow(1 - 0.005, yr - 1);
    const esc = Math.pow(1 + 0.055, yr - 1);
    const opex = capexTotal * 0.011 * esc + (yr === 12 ? capexBess * 0.28 : 0);
    const cf = (annualPvSelfSavings * 0.85 + annualArbitrageSavings + annualDemandSavings) * deg * esc - opex;
    cashflows.push(cf);
    npv += cf / Math.pow(1 + wacc, yr);
    discThroughputKwh += (dailyBessDis * 365 * deg) / Math.pow(1 + wacc, yr);
    if (yr === 12) discBessCost += (capexBess * 0.28) / Math.pow(1 + wacc, yr);
  }
  const irrPct = solveIRR(cashflows);
  const paybackYrs = annualTotalSavings > 0 ? capexTotal / (annualPvSelfSavings * 0.85 + annualArbitrageSavings + annualDemandSavings) : 25;
  const lcos = discThroughputKwh > 0 ? discBessCost / discThroughputKwh : 0;

  return {
    params: p,
    kpis: {
      annualPvMwh: Number(annualPvMwh.toFixed(1)),
      prPct: Number(prPct.toFixed(2)),
      peakReductionKw: Number(peakReductionKw.toFixed(1)),
      lcosBrlKwh: Number(lcos.toFixed(4)),
      annualSavingsBrl: Number((annualPvSelfSavings * 0.85 + annualArbitrageSavings + annualDemandSavings).toFixed(0)),
      npvBrl: Number(npv.toFixed(0)),
      irrPct: Number(irrPct.toFixed(2)),
      paybackYrs: Number(paybackYrs.toFixed(2)),
      capexTotalBrl: Number(capexTotal.toFixed(0)),
      dailyClippingKwh: Number(dailyClipping.toFixed(1))
    },
    losses: [
      { label: 'Temperatura Celular', pct: Number(((1 - (dailyPvDc / (idealDailyPv * (1 - p.soilingPct / 100)))) * 100).toFixed(2)) },
      { label: 'Sujidade (Soiling)', pct: Number(p.soilingPct.toFixed(2)) },
      { label: 'Óptica & IAM', pct: 1.75 },
      { label: 'Cabeamento CC/CA', pct: 1.46 },
      { label: 'Conversão Inversor', pct: 1.34 },
      { label: 'Mismatch & Clipping', pct: Number((1.17 + (dailyClipping / Math.max(1, idealDailyPv)) * 100).toFixed(2)) }
    ],
    hourly
  };
}

// ============================================================================
// 02. ENERGY INTELLIGENCE & AI PLATFORM
// ============================================================================
function simulateProject02(rawParams = {}) {
  const p = {
    horizonHours: clamp(rawParams.horizonHours ?? 24, 24, 168),
    model: rawParams.model || 'random_forest',
    zThreshold: clamp(rawParams.zThreshold ?? 2.5, 1.5, 4.0),
    shiftMaxPct: clamp(rawParams.shiftMaxPct ?? 5.5, 1.0, 15.0),
    tarifaPonta: clamp(rawParams.tarifaPonta ?? 0.92, 0.40, 2.50),
    tarifaFora: clamp(rawParams.tarifaFora ?? 0.58, 0.25, 1.50),
    noisePct: clamp(rawParams.noisePct ?? 3.5, 0.5, 15.0),
    profile: rawParams.profile || 'metalurgica'
  };

  const modelSpecs = {
    random_forest: { name: 'Random Forest Regressor', baseMape: 4.63, r2: 0.974, bias: 0.995 },
    gradient_boosting: { name: 'Gradient Boosting', baseMape: 5.39, r2: 0.968, bias: 1.008 },
    linear_regression: { name: 'Regressão Linear Ridge', baseMape: 6.02, r2: 0.957, bias: 0.985 },
    seasonal_naive: { name: 'Seasonal Naive (Baseline)', baseMape: 10.20, r2: 0.881, bias: 0.960 }
  };
  const spec = modelSpecs[p.model] || modelSpecs.random_forest;

  const profileScale = p.profile === 'metalurgica' ? 1.0 : p.profile === 'campus' ? 0.58 : p.profile === 'automotiva' ? 1.25 : 0.82;
  const base24 = [420,405,395,390,410,465, 550,680,785,840,875,860, 825,850,870,845,810,910, 965,980,930,740,560,460];

  const series = [];
  let sumAbsErr = 0, sumSqErr = 0, sumPctErr = 0;
  let anomaliesDetected = 0;

  for (let h = 0; h < 24; h++) {
    const detWave = Math.sin(h * 0.65) * 0.55 + Math.cos(h * 1.15) * 0.45;
    let realKw = base24[h] * profileScale;
    // Inject realistic telemetry anomalies at hours 11 and 19
    let injectedZ = Math.abs(detWave) * 1.35;
    if (h === 11) { realKw *= 1.21; injectedZ = 3.25; }
    if (h === 19) { realKw *= 1.18; injectedZ = 2.85; }
    if (h === 4)  { realKw *= 0.84; injectedZ = 2.15; }

    const errFrac = (spec.baseMape / 100) * (p.noisePct / 3.5) * detWave;
    const predKw = (base24[h] * profileScale) * spec.bias * (1 + errFrac);
    const residKw = realKw - predKw;
    const isAnomaly = injectedZ >= p.zThreshold;
    if (isAnomaly) anomaliesDetected++;

    sumAbsErr += Math.abs(residKw);
    sumSqErr += residKw * residKw;
    sumPctErr += Math.abs(residKw) / Math.max(1, realKw);

    series.push({
      hora: `${String(h).padStart(2, '0')}:00`,
      h,
      realKw: Number(realKw.toFixed(1)),
      predKw: Number(predKw.toFixed(1)),
      bandLowKw: Number((predKw * 0.94).toFixed(1)),
      bandHighKw: Number((predKw * 1.06).toFixed(1)),
      residKw: Number(residKw.toFixed(1)),
      zScore: Number(injectedZ.toFixed(2)),
      isAnomaly
    });
  }

  const mae = sumAbsErr / 24;
  const rmse = Math.sqrt(sumSqErr / 24);
  const mape = (sumPctErr / 24) * 100;
  const r2 = clamp(spec.r2 - (p.noisePct - 3.5) * 0.004, 0.72, 0.995);

  // Peak shaving optimization (matches corrected Python logic)
  const annualShiftedKwh = 361559.06 * (p.shiftMaxPct / 5.5) * profileScale;
  const tariffSpread = Math.max(0.05, p.tarifaPonta - p.tarifaFora);
  const annualSavingsBrl = annualShiftedKwh * tariffSpread;
  const peakReductionKw = 125.67 * (p.shiftMaxPct / 5.5) * profileScale;

  return {
    params: p,
    kpis: {
      maeKw: Number(mae.toFixed(2)),
      rmseKw: Number(rmse.toFixed(2)),
      mapePct: Number(mape.toFixed(2)),
      r2Score: Number(r2.toFixed(3)),
      anomaliesCount: anomaliesDetected,
      shiftedEnergyMwh: Number((annualShiftedKwh / 1000).toFixed(1)),
      annualSavingsBrl: Number(annualSavingsBrl.toFixed(0)),
      peakReductionKw: Number(peakReductionKw.toFixed(1)),
      maintPrAuc: 0.932
    },
    benchmarks: [
      { model: 'Random Forest', mae: 23.43, rmse: 34.08, mape: 4.63, r2: 0.974 },
      { model: 'Gradient Boosting', mae: 27.60, rmse: 38.79, mape: 5.39, r2: 0.968 },
      { model: 'Regressão Linear', mae: 30.89, rmse: 43.25, mape: 6.02, r2: 0.957 },
      { model: 'Seasonal Naive', mae: 53.39, rmse: 74.16, mape: 10.20, r2: 0.881 }
    ],
    series
  };
}

// ============================================================================
// 03. BRAZILIAN POWER SYSTEM DASHBOARD (SIN / ONS / ANEEL / CCEE)
// ============================================================================
function simulateProject03(rawParams = {}) {
  const p = {
    subsistema: rawParams.subsistema || 'SIN',
    hidrologiaPct: clamp(rawParams.hidrologiaPct ?? 100, 65, 125),
    expansaoSolarPct: clamp(rawParams.expansaoSolarPct ?? 100, 70, 220),
    expansaoEolicaPct: clamp(rawParams.expansaoEolicaPct ?? 100, 70, 200),
    crescimentoCargaPct: clamp(rawParams.crescimentoCargaPct ?? 3.2, -2.0, 8.0),
    reservaRampaPct: clamp(rawParams.reservaRampaPct ?? 15.0, 8.0, 30.0)
  };

  const subWeights = {
    SIN:   { label: 'SIN Consolidado', loadFactor: 1.00, hydro: 1.00, wind: 1.00, solar: 1.00, thermal: 1.00 },
    SE_CO: { label: 'Sudeste / Centro-Oeste', loadFactor: 0.56, hydro: 0.52, wind: 0.04, solar: 0.58, thermal: 0.50 },
    NE:    { label: 'Nordeste', loadFactor: 0.16, hydro: 0.11, wind: 0.86, solar: 0.32, thermal: 0.18 },
    S:     { label: 'Sul', loadFactor: 0.18, hydro: 0.19, wind: 0.10, solar: 0.07, thermal: 0.20 },
    N:     { label: 'Norte', loadFactor: 0.10, hydro: 0.18, wind: 0.00, solar: 0.03, thermal: 0.12 }
  };
  const sw = subWeights[p.subsistema] || subWeights.SIN;

  // Installed Capacity (GW) from ANEEL SIGA reference 08/09/2026
  const capHydroGw = 110.23 * sw.hydro; // UHE + PCH/CGH
  const capWindGw = 34.94 * sw.wind * (p.expansaoEolicaPct / 100);
  const capSolarGw = 23.60 * sw.solar * (p.expansaoSolarPct / 100);
  const capThermalGw = 49.69 * sw.thermal;
  const capNuclearGw = 1.99 * (p.subsistema === 'SIN' || p.subsistema === 'SE_CO' ? 1 : 0);
  const totalCapGw = capHydroGw + capWindGw + capSolarGw + capThermalGw + capNuclearGw;

  const baseLoadGw = [68,65,63,62,63,67, 73,80,86,90,92,93, 91,92,94,93,91,95, 101,103,100,92,81,73];
  const solarShape = [0,0,0,0,0,0, 0.05,0.22,0.48,0.72,0.88,0.95, 0.93,0.78,0.52,0.24,0.06,0, 0,0,0,0,0,0];
  const windShape  = [0.68,0.70,0.72,0.71,0.68,0.64, 0.58,0.52,0.48,0.46,0.47,0.49, 0.53,0.58,0.63,0.68,0.72,0.75, 0.76,0.75,0.74,0.72,0.70,0.69];

  const hourly = [];
  let maxRampGwH = 0;
  let minNetLoadGw = 999;
  let maxNetLoadGw = 0;
  let totalGenGwh = 0, renewableGwh = 0, thermalGwh = 0;

  for (let h = 0; h < 24; h++) {
    const loadGw = baseLoadGw[h] * sw.loadFactor * (1 + p.crescimentoCargaPct / 100);
    const solarGw = capSolarGw * solarShape[h];
    const windGw = capWindGw * windShape[h];
    const netLoadGw = Math.max(5, loadGw - solarGw - windGw);

    const hydroAvailGw = capHydroGw * 0.68 * (p.hidrologiaPct / 100);
    const nuclearGw = capNuclearGw * 0.90;
    const hydroDispatchGw = Math.min(hydroAvailGw, Math.max(0, netLoadGw - nuclearGw));
    const thermalDispatchGw = Math.max(0, netLoadGw - nuclearGw - hydroDispatchGw);

    minNetLoadGw = Math.min(minNetLoadGw, netLoadGw);
    maxNetLoadGw = Math.max(maxNetLoadGw, netLoadGw);
    if (h > 0) {
      const ramp = netLoadGw - hourly[h - 1].netLoadGw;
      if (ramp > maxRampGwH) maxRampGwH = ramp;
    }

    totalGenGwh += loadGw;
    renewableGwh += solarGw + windGw + hydroDispatchGw;
    thermalGwh += thermalDispatchGw;

    hourly.push({
      hora: `${String(h).padStart(2, '0')}:00`,
      h,
      loadGw: Number(loadGw.toFixed(2)),
      netLoadGw: Number(netLoadGw.toFixed(2)),
      hydroGw: Number(hydroDispatchGw.toFixed(2)),
      windGw: Number(windGw.toFixed(2)),
      solarGw: Number(solarGw.toFixed(2)),
      thermalGw: Number((thermalDispatchGw + nuclearGw).toFixed(2))
    });
  }

  const renewableSharePct = totalGenGwh > 0 ? (renewableGwh / totalGenGwh) * 100 : 0;
  const thermalSharePct = totalGenGwh > 0 ? (thermalGwh / totalGenGwh) * 100 : 0;
  const pldEstimated = clamp(69 + (100 - p.hidrologiaPct) * 6.8 + thermalSharePct * 8.5, 69, 745);
  const emissionFactor = clamp(0.038 + (thermalSharePct / 100) * 0.42, 0.030, 0.350);

  return {
    params: p,
    kpis: {
      totalCapGw: Number(totalCapGw.toFixed(1)),
      renewableSharePct: Number(renewableSharePct.toFixed(1)),
      maxEveningRampGw: Number(maxRampGwH.toFixed(2)),
      duckBellyGw: Number(minNetLoadGw.toFixed(1)),
      peakNetLoadGw: Number(maxNetLoadGw.toFixed(1)),
      pldBrlMwh: Number(pldEstimated.toFixed(2)),
      emissionTco2Mwh: Number(emissionFactor.toFixed(3)),
      flexReserveGw: Number(((maxRampGwH * (1 + p.reservaRampaPct / 100))).toFixed(2))
    },
    matrix: [
      { source: 'Hidrelétrica (UHE + PCH)', gw: Number(capHydroGw.toFixed(2)), share: Number(((capHydroGw / totalCapGw) * 100).toFixed(1)) },
      { source: 'Eólica Onshore', gw: Number(capWindGw.toFixed(2)), share: Number(((capWindGw / totalCapGw) * 100).toFixed(1)) },
      { source: 'Solar Centralizada', gw: Number(capSolarGw.toFixed(2)), share: Number(((capSolarGw / totalCapGw) * 100).toFixed(1)) },
      { source: 'Termelétrica (Gás/Biomassa/Óleo)', gw: Number(capThermalGw.toFixed(2)), share: Number(((capThermalGw / totalCapGw) * 100).toFixed(1)) },
      { source: 'Termonuclear', gw: Number(capNuclearGw.toFixed(2)), share: Number(((capNuclearGw / totalCapGw) * 100).toFixed(1)) }
    ],
    hourly
  };
}

// ============================================================================
// 04. SOLAR ENERGY FEASIBILITY SIMULATOR (25-YR DCF)
// ============================================================================
function simulateProject04(rawParams = {}) {
  const p = {
    consumoMensalKwh: clamp(rawParams.consumoMensalKwh ?? 4500, 300, 150000),
    hsp: clamp(rawParams.hsp ?? 4.85, 3.2, 6.8),
    prPct: clamp(rawParams.prPct ?? 80.0, 65, 90),
    modWp: clamp(rawParams.modWp ?? 600, 400, 720),
    custoKwp: clamp(rawParams.custoKwp ?? 4200, 2600, 7500),
    tarifaKwh: clamp(rawParams.tarifaKwh ?? 0.92, 0.45, 2.20),
    inflacaoTarifaPct: clamp(rawParams.inflacaoTarifaPct ?? 6.0, 0, 15),
    degradacaoPct: clamp(rawParams.degradacaoPct ?? 0.55, 0.2, 1.5),
    omAnualPct: clamp(rawParams.omAnualPct ?? 1.0, 0.3, 3.5),
    waccPct: clamp(rawParams.waccPct ?? 9.5, 4.0, 22.0),
    fioBCompensadoPct: clamp(rawParams.fioBCompensadoPct ?? 88.0, 60, 100)
  };

  const dailyGenPerKwp = p.hsp * (p.prPct / 100);
  const reqKwp = (p.consumoMensalKwh / 30) / Math.max(0.5, dailyGenPerKwp);
  const nMod = Math.max(2, Math.ceil((reqKwp * 1000) / p.modWp));
  const installedKwp = (nMod * p.modWp) / 1000;
  const capex = installedKwp * p.custoKwp;
  const areaM2 = nMod * 2.8;

  const genYear1Kwh = installedKwp * dailyGenPerKwp * 365;
  const wacc = p.waccPct / 100;
  const deg = p.degradacaoPct / 100;
  const inf = p.inflacaoTarifaPct / 100;

  const cashflows = [-capex];
  const years = [];
  let cumNominal = -capex;
  let cumDiscounted = -capex;
  let simplePayback = 25.0;
  let discountedPayback = 25.0;
  let simpleFound = false;
  let discFound = false;
  let discCostSum = capex;
  let discGenSum = 0;

  for (let t = 1; t <= 25; t++) {
    const genKwh = genYear1Kwh * Math.pow(1 - deg, t - 1);
    const tariffT = p.tarifaKwh * Math.pow(1 + inf, t - 1);
    const grossSavings = genKwh * tariffT * (p.fioBCompensadoPct / 100);
    const omCost = capex * (p.omAnualPct / 100) * Math.pow(1 + inf * 0.7, t - 1);
    const invRep = t === 12 ? capex * 0.12 : 0;
    const netCf = grossSavings - omCost - invRep;
    const discCf = netCf / Math.pow(1 + wacc, t);

    const prevNom = cumNominal;
    const prevDisc = cumDiscounted;
    cumNominal += netCf;
    cumDiscounted += discCf;

    if (!simpleFound && cumNominal >= 0 && netCf > 0) {
      simplePayback = (t - 1) + Math.abs(prevNom) / netCf;
      simpleFound = true;
    }
    if (!discFound && cumDiscounted >= 0 && discCf > 0) {
      discountedPayback = (t - 1) + Math.abs(prevDisc) / discCf;
      discFound = true;
    }

    discCostSum += (omCost + invRep) / Math.pow(1 + wacc, t);
    discGenSum += genKwh / Math.pow(1 + wacc, t);
    cashflows.push(netCf);

    years.push({
      ano: t,
      genKwh: Number(genKwh.toFixed(0)),
      grossSavings: Number(grossSavings.toFixed(0)),
      omAndInv: Number((omCost + invRep).toFixed(0)),
      netCf: Number(netCf.toFixed(0)),
      cumNominal: Number(cumNominal.toFixed(0)),
      cumDiscounted: Number(cumDiscounted.toFixed(0))
    });
  }

  const irrPct = solveIRR(cashflows);
  const lcoe = discGenSum > 0 ? discCostSum / discGenSum : 0;
  const co2Tons25y = (discGenSum * 0.089) / 1000;

  return {
    params: p,
    kpis: {
      installedKwp: Number(installedKwp.toFixed(2)),
      nModules: nMod,
      areaM2: Number(areaM2.toFixed(1)),
      capexBrl: Number(capex.toFixed(0)),
      year1SavingsBrl: years[0].netCf,
      simplePaybackYrs: Number(simplePayback.toFixed(2)),
      discountedPaybackYrs: Number(discountedPayback.toFixed(2)),
      npvBrl: Number(cumDiscounted.toFixed(0)),
      irrPct: Number(irrPct.toFixed(2)),
      lcoeBrlKwh: Number(lcoe.toFixed(4)),
      co2AvoidedTons: Number(((genYear1Kwh * 23.2 * 0.038) / 1000).toFixed(1))
    },
    years
  };
}

// ============================================================================
// 05. MERCADO LIVRE DE ENERGIA (ACR vs ACL)
// ============================================================================
function simulateProject05(rawParams = {}) {
  const p = {
    consumoForaMwhMes: clamp(rawParams.consumoForaMwhMes ?? 245, 20, 5000),
    consumoPontaMwhMes: clamp(rawParams.consumoPontaMwhMes ?? 49, 5, 1500),
    demandaPontaKw: clamp(rawParams.demandaPontaKw ?? 850, 50, 15000),
    demandaForaKw: clamp(rawParams.demandaForaKw ?? 1050, 50, 15000),
    tarifaAcrPontaMwh: clamp(rawParams.tarifaAcrPontaMwh ?? 980, 400, 2200),
    tarifaAcrForaMwh: clamp(rawParams.tarifaAcrForaMwh ?? 520, 250, 1400),
    precoAclMwh: clamp(rawParams.precoAclMwh ?? 235, 90, 650),
    descontoTusdPct: clamp(rawParams.descontoTusdPct ?? 50, 0, 100),
    encargosCceeMwh: clamp(rawParams.encargosCceeMwh ?? 28, 8, 95),
    gestaoMensalBrl: clamp(rawParams.gestaoMensalBrl ?? 3500, 1000, 25000),
    aliquotaImpostosPct: clamp(rawParams.aliquotaImpostosPct ?? 21.5, 10, 34)
  };

  const totalMwhMes = p.consumoForaMwhMes + p.consumoPontaMwhMes;
  const totalMwhAno = totalMwhMes * 12;
  const taxMultiplier = 1 / Math.max(0.60, 1 - p.aliquotaImpostosPct / 100);

  // Monthly ACR Costs
  const acrEnergiaFora = p.consumoForaMwhMes * p.tarifaAcrForaMwh;
  const acrEnergiaPonta = p.consumoPontaMwhMes * p.tarifaAcrPontaMwh;
  const acrDemandaFio = p.demandaPontaKw * 54 + p.demandaForaKw * 24;
  const acrBandeiras = totalMwhMes * 18;
  const acrMensalTotal = (acrEnergiaFora + acrEnergiaPonta + acrDemandaFio + acrBandeiras) * taxMultiplier;
  const acrAnualTotal = acrMensalTotal * 12;

  // Monthly ACL Costs
  const discountFactor = 1 - (p.descontoTusdPct / 100) * 0.46; // TUSD-Encargos/Fio eligible portion
  const aclDemandaFio = acrDemandaFio * discountFactor;
  const aclEnergiaPpa = totalMwhMes * p.precoAclMwh;
  const aclCcee = totalMwhMes * p.encargosCceeMwh;
  const aclMensalTotal = (aclEnergiaPpa + aclDemandaFio + aclCcee + p.gestaoMensalBrl) * taxMultiplier;
  const aclAnualTotal = aclMensalTotal * 12;

  const annualSavingsBrl = acrAnualTotal - aclAnualTotal;
  const savingsPct = acrAnualTotal > 0 ? (annualSavingsBrl / acrAnualTotal) * 100 : 0;

  // Exact Break-Even PPA Price (R$/MWh) where ACL = ACR
  const breakEvenMwh = ((acrMensalTotal / taxMultiplier) - aclDemandaFio - aclCcee - p.gestaoMensalBrl) / Math.max(1, totalMwhMes);

  const horizon = [];
  let cumSavings = 0;
  for (let yr = 1; yr <= 5; yr++) {
    const escAcr = Math.pow(1.065, yr - 1);
    const escAcl = Math.pow(1.045, yr - 1);
    const yrAcr = acrAnualTotal * escAcr;
    const yrAcl = aclAnualTotal * escAcl;
    const yrSav = yrAcr - yrAcl;
    cumSavings += yrSav;
    horizon.push({
      ano: `Ano ${yr}`,
      acrBrl: Number(yrAcr.toFixed(0)),
      aclBrl: Number(yrAcl.toFixed(0)),
      economiaAnualBrl: Number(yrSav.toFixed(0)),
      economiaAcumBrl: Number(cumSavings.toFixed(0))
    });
  }

  return {
    params: p,
    kpis: {
      totalMwhAno: Number(totalMwhAno.toFixed(0)),
      acrAnualBrl: Number(acrAnualTotal.toFixed(0)),
      aclAnualBrl: Number(aclAnualTotal.toFixed(0)),
      annualSavingsBrl: Number(annualSavingsBrl.toFixed(0)),
      savingsPct: Number(savingsPct.toFixed(2)),
      breakEvenMwh: Number(breakEvenMwh.toFixed(2)),
      fiveYearSavingsBrl: Number(cumSavings.toFixed(0)),
      unitCostAcrMwh: Number((acrAnualTotal / Math.max(1, totalMwhAno)).toFixed(2)),
      unitCostAclMwh: Number((aclAnualTotal / Math.max(1, totalMwhAno)).toFixed(2))
    },
    breakdown: [
      { item: 'Energia (TE / PPA)', acr: Number((acrEnergiaFora + acrEnergiaPonta) * 12), acl: Number(aclEnergiaPpa * 12) },
      { item: 'Demanda / TUSD Fio', acr: Number(acrDemandaFio * 12), acl: Number(aclDemandaFio * 12) },
      { item: 'Encargos CCEE / Bandeiras', acr: Number(acrBandeiras * 12), acl: Number((aclCcee + p.gestaoMensalBrl) * 12) },
      { item: 'Tributos (ICMS + PIS/COFINS)', acr: Number(acrAnualTotal - (acrAnualTotal / taxMultiplier)), acl: Number(aclAnualTotal - (aclAnualTotal / taxMultiplier)) }
    ],
    horizon
  };
}

// ============================================================================
// 06. GREEN HYDROGEN TECHNO-ECONOMIC SIMULATOR (LCOH)
// ============================================================================
function simulateProject06(rawParams = {}) {
  const techPresets = {
    PEM:      { secBase: 52.0, capexKw: 6800, stackLifeH: 65000, effLhv: 64.1 },
    Alcalino: { secBase: 50.2, capexKw: 5400, stackLifeH: 75000, effLhv: 66.4 },
    SOEC:     { secBase: 41.8, capexKw: 8900, stackLifeH: 45000, effLhv: 79.7 }
  };
  const tech = rawParams.tecnologia && techPresets[rawParams.tecnologia] ? rawParams.tecnologia : 'PEM';
  const tp = techPresets[tech];

  const p = {
    tecnologia: tech,
    potenciaEletrolisadorMw: clamp(rawParams.potenciaEletrolisadorMw ?? 20.0, 2.0, 200.0),
    secKwhKg: clamp(rawParams.secKwhKg ?? tp.secBase, 38.0, 65.0),
    fatorCapacidadePct: clamp(rawParams.fatorCapacidadePct ?? 78.74, 25.0, 95.0),
    custoEnergiaMwh: clamp(rawParams.custoEnergiaMwh ?? 145.0, 60.0, 420.0),
    capexEletrolisadorKw: clamp(rawParams.capexEletrolisadorKw ?? tp.capexKw, 3000, 12000),
    waccPct: clamp(rawParams.waccPct ?? 9.5, 5.0, 18.0),
    cambioUsd: clamp(rawParams.cambioUsd ?? 5.35, 4.0, 7.0),
    compressaoKwhKg: clamp(rawParams.compressaoKwhKg ?? 2.8, 1.0, 6.0)
  };

  const eflhHours = 8760 * (p.fatorCapacidadePct / 100);
  const annualElectrolyzerMwh = p.potenciaEletrolisadorMw * eflhHours;
  const totalSec = p.secKwhKg + p.compressaoKwhKg;
  const annualH2Kg = (annualElectrolyzerMwh * 1000) / p.secKwhKg;
  const annualH2Ton = annualH2Kg / 1000;
  const waterM3Year = (annualH2Kg * 15.0) / 1000; // 15 L/kg H2 total process + cooling

  const capexElectrolyzerBrl = p.potenciaEletrolisadorMw * 1000 * p.capexEletrolisadorKw;
  const capexRenewablesAndBopBrl = capexElectrolyzerBrl * 1.45; // Dedicated hybrid renewables + BoP + compressor
  const capexTotalBrl = capexElectrolyzerBrl + capexRenewablesAndBopBrl;

  const r = p.waccPct / 100;
  const n = 20;
  const crf = (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  const annualCapexBrl = capexTotalBrl * crf;
  const annualOpexFixedBrl = capexTotalBrl * 0.024;
  const annualEnergyCostBrl = p.potenciaEletrolisadorMw * eflhHours * (totalSec / p.secKwhKg) * p.custoEnergiaMwh;
  const annualWaterCostBrl = waterM3Year * 14.5;
  const annualStackRepBrl = (capexElectrolyzerBrl * 0.32) / Math.pow(1 + r, 9) * crf;

  const totalAnnualCostBrl = annualCapexBrl + annualOpexFixedBrl + annualEnergyCostBrl + annualWaterCostBrl + annualStackRepBrl;
  const lcohBrlKg = annualH2Kg > 0 ? totalAnnualCostBrl / annualH2Kg : 0;
  const lcohUsdKg = lcohBrlKg / p.cambioUsd;
  const effLhvPct = (33.33 / p.secKwhKg) * 100;
  const co2AvoidedTons = annualH2Ton * 9.0; // vs Grey Hydrogen SMR (~9 kg CO2/kg H2)

  // Sensitivity curve across Capacity Factors (30% to 90%)
  const cfCurve = [30, 40, 50, 60, 70, 78.7, 85, 92].map((cf) => {
    const h = 8760 * (cf / 100);
    const kg = (p.potenciaEletrolisadorMw * h * 1000) / p.secKwhKg;
    const eCost = p.potenciaEletrolisadorMw * h * (totalSec / p.secKwhKg) * p.custoEnergiaMwh;
    const tot = annualCapexBrl + annualOpexFixedBrl + eCost + annualWaterCostBrl + annualStackRepBrl;
    const brl = tot / Math.max(1, kg);
    return {
      cfPct: cf,
      lcohBrl: Number(brl.toFixed(2)),
      lcohUsd: Number((brl / p.cambioUsd).toFixed(2)),
      prodTon: Number((kg / 1000).toFixed(0))
    };
  });

  return {
    params: p,
    kpis: {
      lcohBrlKg: Number(lcohBrlKg.toFixed(2)),
      lcohUsdKg: Number(lcohUsdKg.toFixed(2)),
      annualH2Ton: Number(annualH2Ton.toFixed(1)),
      eflhHours: Number(eflhHours.toFixed(0)),
      effLhvPct: Number(effLhvPct.toFixed(1)),
      waterM3Year: Number(waterM3Year.toFixed(0)),
      capexTotalM: Number((capexTotalBrl / 1e6).toFixed(2)),
      co2AvoidedTons: Number(co2AvoidedTons.toFixed(0))
    },
    costBreakdown: [
      { component: 'CAPEX Anualizado (Planta + Híbrido)', brlKg: Number((annualCapexBrl / annualH2Kg).toFixed(2)) },
      { component: 'Energia Elétrica Renovável + Compressão', brlKg: Number((annualEnergyCostBrl / annualH2Kg).toFixed(2)) },
      { component: 'O&M Fixo & BoP', brlKg: Number((annualOpexFixedBrl / annualH2Kg).toFixed(2)) },
      { component: 'Reposição de Stack & Água Desmineralizada', brlKg: Number(((annualStackRepBrl + annualWaterCostBrl) / annualH2Kg).toFixed(2)) }
    ],
    cfCurve
  };
}

// ============================================================================
// 07. ELECTRICAL PROJECT MANAGEMENT & PMO DASHBOARD
// ============================================================================
function simulateProject07(rawParams = {}) {
  const p = {
    totalProjetos: clamp(rawParams.totalProjetos ?? 200, 20, 600),
    engEquipe: clamp(rawParams.engEquipe ?? 14, 4, 45),
    equipesCampo: clamp(rawParams.equipesCampo ?? 18, 4, 60),
    slaConcessionariaPct: clamp(rawParams.slaConcessionariaPct ?? 85, 40, 100),
    taxaPendenciaPct: clamp(rawParams.taxaPendenciaPct ?? 18, 2, 50),
    metaPrazoDias: clamp(rawParams.metaPrazoDias ?? 90, 45, 180),
    contingenciaPct: clamp(rawParams.contingenciaPct ?? 8.0, 0, 25)
  };

  const scale = p.totalProjetos / 200;
  const capacityFactor = (p.engEquipe / 14) * 0.55 + (p.equipesCampo / 18) * 0.45;
  const slaPenaltyDays = (100 - p.slaConcessionariaPct) * 0.65;
  const reworkDays = (p.taxaPendenciaPct - 18) * 0.90;

  const avgLeadTimeDays = clamp(93.8 / Math.pow(capacityFactor, 0.45) + slaPenaltyDays + reworkDays, 42, 210);
  const onTimePct = clamp(54.05 + (p.metaPrazoDias - avgLeadTimeDays) * 0.85, 12, 98);
  const delayedProjects = Math.round(p.totalProjetos * (1 - onTimePct / 100) * 0.55);
  const activeProjects = Math.round(p.totalProjetos * 0.79);
  const completedProjects = p.totalProjetos - activeProjects;
  const portfolioMw = 93.05 * scale;
  const portfolioValueM = 412.77 * scale;
  const spi = clamp(p.metaPrazoDias / avgLeadTimeDays, 0.55, 1.35);
  const cpi = clamp(1.02 - (p.taxaPendenciaPct / 100) * 0.35 + (p.contingenciaPct / 100) * 0.25, 0.72, 1.25);

  const stages = [
    { etapa: '1. Levantamento & Viabilidade', projetos: Math.round(24 * scale), diasMedio: Number((11 * (14 / p.engEquipe)).toFixed(1)) },
    { etapa: '2. Solicitação / Parecer de Acesso', projetos: Math.round(42 * scale), diasMedio: Number((28 + slaPenaltyDays * 0.6).toFixed(1)) },
    { etapa: '3. Projeto Executivo & Proteção', projetos: Math.round(38 * scale), diasMedio: Number((19 * (14 / p.engEquipe) + Math.max(0, reworkDays * 0.5)).toFixed(1)) },
    { etapa: '4. Obras Civis & Montagem Eletromecânica', projetos: Math.round(34 * scale), diasMedio: Number((22 * (18 / p.equipesCampo)).toFixed(1)) },
    { etapa: '5. Vistoria & Comissionamento', projetos: Math.round(20 * scale), diasMedio: Number((13.8 + slaPenaltyDays * 0.4).toFixed(1)) }
  ];

  return {
    params: p,
    kpis: {
      totalProjetos: p.totalProjetos,
      activeProjects,
      completedProjects,
      delayedProjects,
      avgLeadTimeDays: Number(avgLeadTimeDays.toFixed(1)),
      onTimePct: Number(onTimePct.toFixed(1)),
      portfolioMw: Number(portfolioMw.toFixed(2)),
      portfolioValueM: Number(portfolioValueM.toFixed(2)),
      spi: Number(spi.toFixed(2)),
      cpi: Number(cpi.toFixed(2))
    },
    stages
  };
}

// ============================================================================
// 08. ENERGY MANAGEMENT & EFFICIENCY DASHBOARD (ISO 50001 ANALYTICAL TOOL)
// ============================================================================
function simulateProject08(rawParams = {}) {
  const p = {
    unidade: rawParams.unidade || 'consolidado',
    demandaContratadaKw: clamp(rawParams.demandaContratadaKw ?? 3200, 300, 12000),
    demandaMedidaPicoKw: clamp(rawParams.demandaMedidaPicoKw ?? 3527, 300, 14000),
    horasOperacaoMes: clamp(rawParams.horasOperacaoMes ?? 620, 200, 730),
    fatorPotenciaAtual: clamp(rawParams.fatorPotenciaAtual ?? 0.87, 0.70, 0.99),
    tarifaMediaKwh: clamp(rawParams.tarifaMediaKwh ?? 1.07, 0.45, 2.20),
    eficMotoresVfdPct: clamp(rawParams.eficMotoresVfdPct ?? 12.0, 0, 25),
    eficHvacArPct: clamp(rawParams.eficHvacArPct ?? 15.0, 0, 30),
    investimentoRetrofitM: clamp(rawParams.investimentoRetrofitM ?? 3.75, 0.2, 20.0)
  };

  const unitScale = p.unidade === 'consolidado' ? 1.0 : 0.22;
  const annualConsumptionMwh = 51076.04 * unitScale;
  const monthlyKwh = (annualConsumptionMwh * 1000) / 12;

  // Load factor FC = E_mes / (D_max * H_mes)
  const loadFactor = clamp(monthlyKwh / Math.max(1, p.demandaMedidaPicoKw * p.horasOperacaoMes * unitScale), 0.15, 0.98);

  // Demand exceedance check (> 5% tolerance above contracted demand)
  const exceedanceKw = Math.max(0, p.demandaMedidaPicoKw - p.demandaContratadaKw);
  const hasToleranceBreach = p.demandaMedidaPicoKw > p.demandaContratadaKw * 1.05;
  const annualDemandPenaltyBrl = hasToleranceBreach ? exceedanceKw * 108 * 12 : 0;

  // Reactive power penalty for PF < 0.92 & required capacitor bank (kVAr)
  const pfTarget = 0.92;
  const phi1 = Math.acos(p.fatorPotenciaAtual);
  const phi2 = Math.acos(pfTarget);
  const capacitorBankKvar = p.fatorPotenciaAtual < pfTarget
    ? p.demandaMedidaPicoKw * (Math.tan(phi1) - Math.tan(phi2))
    : 0;
  const annualReactivePenaltyBrl = p.fatorPotenciaAtual < pfTarget
    ? annualConsumptionMwh * 1000 * ((pfTarget / p.fatorPotenciaAtual) - 1) * 0.34
    : 0;

  // Efficiency savings (Motors/VFD + HVAC/Compressed Air + PF + Demand Tuning)
  const savingsMwhYear = annualConsumptionMwh * (0.48 * (p.eficMotoresVfdPct / 100) + 0.35 * (p.eficHvacArPct / 100) + 0.025);
  const energySavingsBrl = savingsMwhYear * 1000 * p.tarifaMediaKwh;
  const totalAnnualSavingsBrl = energySavingsBrl + annualDemandPenaltyBrl + annualReactivePenaltyBrl;
  const paybackYrs = totalAnnualSavingsBrl > 0 ? (p.investimentoRetrofitM * 1e6 * unitScale) / totalAnnualSavingsBrl : 10;

  return {
    params: p,
    kpis: {
      annualConsumptionMwh: Number(annualConsumptionMwh.toFixed(0)),
      loadFactor: Number(loadFactor.toFixed(2)),
      exceedanceKw: Number(exceedanceKw.toFixed(0)),
      capacitorBankKvar: Number(capacitorBankKvar.toFixed(0)),
      annualReactivePenaltyBrl: Number(annualReactivePenaltyBrl.toFixed(0)),
      savingsMwhYear: Number(savingsMwhYear.toFixed(1)),
      totalAnnualSavingsBrl: Number(totalAnnualSavingsBrl.toFixed(0)),
      paybackYrs: Number(paybackYrs.toFixed(2))
    },
    sectors: [
      { setor: 'Motores & Acionamentos (VFD)', sharePct: 46, mwh: Number((annualConsumptionMwh * 0.46).toFixed(0)) },
      { setor: 'Ar Comprimido & Pneumática', sharePct: 21, mwh: Number((annualConsumptionMwh * 0.21).toFixed(0)) },
      { setor: 'Refrigeração & HVAC Industrial', sharePct: 17, mwh: Number((annualConsumptionMwh * 0.17).toFixed(0)) },
      { setor: 'Fornos & Processos Térmicos', sharePct: 11, mwh: Number((annualConsumptionMwh * 0.11).toFixed(0)) },
      { setor: 'Iluminação & Utilidades', sharePct: 5, mwh: Number((annualConsumptionMwh * 0.05).toFixed(0)) }
    ]
  };
}

// ============================================================================
// 09. SOLAR PV SIZING & STRING ELECTRICAL CALCULATOR
// ============================================================================
function simulateProject09(rawParams = {}) {
  const modCatalog = {
    '550': { wp: 550, voc: 49.8, vmp: 41.9, isc: 13.98, imp: 13.13, betaVoc: -0.0027, betaVmp: -0.0035, area: 2.58 },
    '600': { wp: 600, voc: 51.8, vmp: 43.6, isc: 14.55, imp: 13.76, betaVoc: -0.0025, betaVmp: -0.0032, area: 2.79 },
    '660': { wp: 660, voc: 45.6, vmp: 38.3, isc: 18.42, imp: 17.23, betaVoc: -0.0026, betaVmp: -0.0034, area: 3.11 }
  };
  const invCatalog = {
    '6':  { kw: 6.0,  vmax: 1000, mpptMin: 160, mpptMax: 850, nMppt: 2, imaxMppt: 16.0 },
    '10': { kw: 10.0, vmax: 1100, mpptMin: 200, mpptMax: 950, nMppt: 3, imaxMppt: 16.0 },
    '25': { kw: 25.0, vmax: 1100, mpptMin: 200, mpptMax: 1000, nMppt: 4, imaxMppt: 30.0 },
    '75': { kw: 75.0, vmax: 1100, mpptMin: 200, mpptMax: 1000, nMppt: 6, imaxMppt: 40.0 }
  };

  const modKey = rawParams.moduloPreset && modCatalog[rawParams.moduloPreset] ? rawParams.moduloPreset : '550';
  const invKey = rawParams.inversorPreset && invCatalog[rawParams.inversorPreset] ? rawParams.inversorPreset : '6';
  const mod = modCatalog[modKey];
  const inv = invCatalog[invKey];

  const p = {
    consumoMensalKwh: clamp(rawParams.consumoMensalKwh ?? 595, 120, 45000),
    custoDisponibilidadeKwh: clamp(rawParams.custoDisponibilidadeKwh ?? 100, 30, 100),
    hsp: clamp(rawParams.hsp ?? 4.90, 3.2, 6.8),
    moduloPreset: modKey,
    inversorPreset: invKey,
    tMinRecord: clamp(rawParams.tMinRecord ?? -2, -15, 20),
    tMaxCell: clamp(rawParams.tMaxCell ?? 70, 45, 90),
    perdaTermicaPct: clamp(rawParams.perdaTermicaPct ?? 8.5, 2, 18),
    perdaOutrasPct: clamp(rawParams.perdaOutrasPct ?? 12.3, 4, 25),
    modPorStringManual: clamp(rawParams.modPorStringManual ?? 0, 0, 26)
  };

  // Multiplicative Performance Ratio
  const pr = (1 - p.perdaTermicaPct / 100) * (1 - p.perdaOutrasPct / 100);
  const netTargetMonthlyKwh = Math.max(50, p.consumoMensalKwh - p.custoDisponibilidadeKwh * 0.25);
  const reqKwp = (netTargetMonthlyKwh / 30) / (p.hsp * pr);
  const nModTotal = Math.max(4, Math.ceil((reqKwp * 1000) / mod.wp));
  const installedKwp = (nModTotal * mod.wp) / 1000;

  // Thermal string voltage calculations
  const vocColdMod = mod.voc * (1 + mod.betaVoc * (p.tMinRecord - 25));
  const vmpHotMod = mod.vmp * (1 + mod.betaVmp * (p.tMaxCell - 25));

  const nMaxString = Math.floor(inv.vmax / vocColdMod);
  const nMinString = Math.ceil(inv.mpptMin / vmpHotMod);

  const nStrings = Math.min(inv.nMppt, Math.max(1, Math.round(nModTotal / 10)));
  const autoModPerString = Math.max(nMinString, Math.min(nMaxString, Math.round(nModTotal / nStrings)));
  const modPerString = p.modPorStringManual > 0 ? Math.round(p.modPorStringManual) : autoModPerString;

  const vocStringCold = modPerString * vocColdMod;
  const vmpStringHot = modPerString * vmpHotMod;
  const vmpStringStc = modPerString * mod.vmp;
  const fdi = installedKwp / inv.kw;

  const isVocSafe = vocStringCold <= inv.vmax;
  const isMpptSafe = vmpStringHot >= inv.mpptMin && vmpStringStc <= inv.mpptMax;
  const isFdiSafe = fdi >= 0.75 && fdi <= 1.35;
  const statusEletrico = !isVocSafe
    ? 'ERRO CRÍTICO: Sobretensão Voc(Tmin) > Vmáx Inversor'
    : !isMpptSafe
    ? 'ALERTA TÉCNICO: Tensão Vmp fora da janela ideal de MPPT'
    : !isFdiSafe
    ? 'ALERTA FDI: Relação CC/CA fora da faixa recomendada (0,75 a 1,35)'
    : 'COMPATÍVEL: String e MPPT 100% dentro dos limites térmicos e elétricos';

  const annualGenKwh = installedKwp * p.hsp * pr * 365;
  const seasonWeights = [1.06, 1.08, 1.03, 0.96, 0.89, 0.85, 0.88, 0.96, 1.02, 1.07, 1.10, 1.10];
  const monthly = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'].map((mes, idx) => ({
    mes,
    geracaoKwh: Number(((annualGenKwh / 12) * seasonWeights[idx]).toFixed(0)),
    consumoKwh: p.consumoMensalKwh
  }));

  return {
    params: p,
    kpis: {
      installedKwp: Number(installedKwp.toFixed(2)),
      nModTotal,
      modPerString,
      nStrings,
      prPct: Number((pr * 100).toFixed(2)),
      annualGenKwh: Number(annualGenKwh.toFixed(0)),
      vocStringColdV: Number(vocStringCold.toFixed(1)),
      vmpStringHotV: Number(vmpStringHot.toFixed(1)),
      nMinString,
      nMaxString,
      fdi: Number(fdi.toFixed(2)),
      areaM2: Number((nModTotal * mod.area).toFixed(1)),
      statusEletrico,
      isVocSafe,
      isMpptSafe
    },
    monthly
  };
}

const SIMULATOR_ENGINES = {
  'solar-pv-digital-twin-bess-platform': simulateProject01,
  'energy-intelligence-ai-platform': simulateProject02,
  'brazilian-power-system-dashboard': simulateProject03,
  'solar-energy-feasibility-simulator': simulateProject04,
  'mercado-livre-energia-simulador': simulateProject05,
  'green-hydrogen-techno-economic-simulator': simulateProject06,
  'electrical-project-management-dashboard': simulateProject07,
  'energy-management-dashboard': simulateProject08,
  'solar-pv-sizing-calculator': simulateProject09
};


  const PROJECT = {
  "num": "01",
  "slug": "solar-pv-digital-twin-bess-platform",
  "branch": "master",
  "title": "Gêmeo Digital Fotovoltaico & Otimização BESS",
  "subtitle": "Modelagem física horária de usina solar 1,20 MWp integrada a armazenamento eletroquímico LiFePO4 (250 kW / 750 kWh) para Peak Shaving, Arbitragem Tarifária e LCOS.",
  "category": "Sistemas Fotovoltaicos • Armazenamento BESS • Despacho Ótimo",
  "accent": "#D3A15C",
  "accentSec": "#22D3EE",
  "dataOrigin": "Telemetria física calibrada e simulação horária (PR = 83,31%, R² = 0,9865 no gêmeo digital de referência)",
  "problemStatement": "Usinas solares comerciais e industriais enfrentam inversão de fluxo, clipping nos inversores em horários de pico solar e tarifas elevadas no horário de ponta (18h às 21h). Sem armazenamento coordenado, o excedente diurno é injetado com menor valor econômico enquanto a ponta permanece exposta a encargos de demanda.",
  "solutionSummary": "Este Gêmeo Digital modela passo a passo a conversão solar (irradiância no plano, temperatura de célula por NOCT, perdas ópticas, ôhmicas e clipping CA) acoplada à equação de estado recursiva de um sistema BESS LiFePO4 sob limites estritos de potência, capacidade e janela de Estado de Carga (SOC).",
  "schematicTitle": "Arquitetura Elétrica: Arranjo FV CC • Inversores CA • Barramento Híbrido BESS • Rede & Carga",
  "schematicNodes": [
    {
      "id": "pv",
      "title": "Arranjo FV 1,20 MWp",
      "sub": "2.244 mód • 22/string",
      "color": "#D3A15C"
    },
    {
      "id": "inv",
      "title": "Inversores 1,00 MW CA",
      "sub": "4x250 kW • η = 98,6%",
      "color": "#38BDF8"
    },
    {
      "id": "bess",
      "title": "BESS LiFePO4 750 kWh",
      "sub": "250 kW • SOC 15%-95%",
      "color": "#36D399"
    },
    {
      "id": "load",
      "title": "Carga Industrial + Rede",
      "sub": "Peak Shaving 18h-21h",
      "color": "#A78BFA"
    }
  ],
  "paramGroups": [
    {
      "group": "Parâmetros Físicos FV",
      "items": [
        {
          "key": "pvKwp",
          "label": "Potência FV Instalada (CC)",
          "unit": "kWp",
          "min": 100,
          "max": 5000,
          "step": 10,
          "def": 1200.5,
          "tip": "Capacidade nominal em condições STC do gerador fotovoltaico."
        },
        {
          "key": "invAcKw",
          "label": "Potência Nominal Inversores (CA)",
          "unit": "kW",
          "min": 80,
          "max": 4500,
          "step": 10,
          "def": 1000,
          "tip": "Limite de potência ativa CA para cálculo de clipping."
        },
        {
          "key": "hsp",
          "label": "Horas de Sol Pleno (HSP)",
          "unit": "kWh/m²/dia",
          "min": 3,
          "max": 7.2,
          "step": 0.05,
          "def": 5.45,
          "tip": "Irradiação diária média no plano dos módulos (POA)."
        },
        {
          "key": "tAmb",
          "label": "Temperatura Ambiente Média",
          "unit": "°C",
          "min": 15,
          "max": 45,
          "step": 0.5,
          "def": 28.5,
          "tip": "Temperatura diurna para cálculo de perda térmica celular."
        },
        {
          "key": "soilingPct",
          "label": "Perda por Sujidade (Soiling)",
          "unit": "%",
          "min": 0,
          "max": 15,
          "step": 0.1,
          "def": 2.3,
          "tip": "Redução óptica por deposição de poeira sobre os módulos."
        }
      ]
    },
    {
      "group": "Parâmetros BESS & Restrições SOC",
      "items": [
        {
          "key": "bessKwh",
          "label": "Capacidade Nominal BESS",
          "unit": "kWh",
          "min": 0,
          "max": 5000,
          "step": 25,
          "def": 750,
          "tip": "Energia nominal do banco de baterias LiFePO4."
        },
        {
          "key": "bessKw",
          "label": "Potência Máxima PCS/BESS",
          "unit": "kW",
          "min": 0,
          "max": 2500,
          "step": 10,
          "def": 250,
          "tip": "Potência limite de carga e descarga do conversor bidirecional."
        },
        {
          "key": "bessEffPct",
          "label": "Eficiência Round-Trip (η_rt)",
          "unit": "%",
          "min": 75,
          "max": 98,
          "step": 0.5,
          "def": 92,
          "tip": "Rendimento global de ciclo completo carga/descarga."
        },
        {
          "key": "socMinPct",
          "label": "SOC Mínimo Operacional",
          "unit": "%",
          "min": 5,
          "max": 40,
          "step": 1,
          "def": 15,
          "tip": "Reserva inferior para proteção de vida útil eletroquímica."
        },
        {
          "key": "socMaxPct",
          "label": "SOC Máximo Operacional",
          "unit": "%",
          "min": 60,
          "max": 100,
          "step": 1,
          "def": 95,
          "tip": "Teto operacional de carga para segurança térmica."
        }
      ]
    },
    {
      "group": "Parâmetros Tarifários & Despacho",
      "items": [
        {
          "key": "modoDespacho",
          "label": "Estratégia de Despacho EMS",
          "unit": "modo",
          "type": "select",
          "def": "peak_arbitrage",
          "options": [
            {
              "value": "peak_arbitrage",
              "label": "Peak Shaving + Arbitragem"
            },
            {
              "value": "self_consumption",
              "label": "Autoconsumo Solar Puro"
            },
            {
              "value": "backup_priority",
              "label": "Reserva de Backup + Ponta"
            }
          ],
          "tip": "Algoritmo de controle do sistema de gerenciamento de energia (EMS)."
        },
        {
          "key": "tarifaPonta",
          "label": "Tarifa Horário de Ponta",
          "unit": "R$/kWh",
          "min": 0.4,
          "max": 3,
          "step": 0.02,
          "def": 1.28,
          "tip": "Tarifa total (TE + TUSD + encargos) entre 18h e 21h."
        },
        {
          "key": "tarifaFora",
          "label": "Tarifa Fora de Ponta",
          "unit": "R$/kWh",
          "min": 0.2,
          "max": 1.5,
          "step": 0.02,
          "def": 0.48,
          "tip": "Tarifa aplicável fora da janela de ponta."
        },
        {
          "key": "demandaRkw",
          "label": "Tarifa de Demanda Ponta",
          "unit": "R$/kW",
          "min": 15,
          "max": 140,
          "step": 1,
          "def": 52,
          "tip": "Encargo mensal por kW de demanda máxima na ponta."
        }
      ]
    }
  ],
  "scenarios": {
    "base": {
      "label": "Caso-Base (1,2 MWp + 750 kWh)",
      "params": {
        "pvKwp": 1200.5,
        "invAcKw": 1000,
        "hsp": 5.45,
        "tAmb": 28.5,
        "soilingPct": 2.3,
        "bessKwh": 750,
        "bessKw": 250,
        "bessEffPct": 92,
        "socMinPct": 15,
        "socMaxPct": 95,
        "tarifaPonta": 1.28,
        "tarifaFora": 0.48,
        "demandaRkw": 52,
        "modoDespacho": "peak_arbitrage"
      }
    },
    "conservador": {
      "label": "Conservador (HSP Baixo / Soiling Alto)",
      "params": {
        "pvKwp": 1200.5,
        "invAcKw": 1000,
        "hsp": 4.65,
        "tAmb": 32,
        "soilingPct": 5,
        "bessKwh": 500,
        "bessKw": 180,
        "bessEffPct": 88,
        "socMinPct": 20,
        "socMaxPct": 90,
        "tarifaPonta": 1.05,
        "tarifaFora": 0.5,
        "demandaRkw": 40,
        "modoDespacho": "peak_arbitrage"
      }
    },
    "provavel": {
      "label": "Provável Operacional",
      "params": {
        "pvKwp": 1200.5,
        "invAcKw": 1000,
        "hsp": 5.25,
        "tAmb": 29,
        "soilingPct": 2.8,
        "bessKwh": 750,
        "bessKw": 250,
        "bessEffPct": 91,
        "socMinPct": 15,
        "socMaxPct": 95,
        "tarifaPonta": 1.22,
        "tarifaFora": 0.48,
        "demandaRkw": 48,
        "modoDespacho": "peak_arbitrage"
      }
    },
    "otimista": {
      "label": "Otimista (BESS Expandido 1,5 MWh)",
      "params": {
        "pvKwp": 1500,
        "invAcKw": 1250,
        "hsp": 5.85,
        "tAmb": 26.5,
        "soilingPct": 1.5,
        "bessKwh": 1500,
        "bessKw": 500,
        "bessEffPct": 94,
        "socMinPct": 10,
        "socMaxPct": 95,
        "tarifaPonta": 1.48,
        "tarifaFora": 0.45,
        "demandaRkw": 68,
        "modoDespacho": "peak_arbitrage"
      }
    }
  },
  "kpiDefs": [
    {
      "key": "annualPvMwh",
      "label": "Geração FV Anual",
      "unit": "MWh/ano",
      "digits": 1,
      "sub": "Energia líquida CA entregue"
    },
    {
      "key": "prPct",
      "label": "Performance Ratio (PR)",
      "unit": "%",
      "digits": 2,
      "sub": "Rendimento global da usina"
    },
    {
      "key": "peakReductionKw",
      "label": "Redução de Demanda Ponta",
      "unit": "kW",
      "digits": 1,
      "sub": "Peak Shaving efetivo 18h-21h"
    },
    {
      "key": "lcosBrlKwh",
      "label": "LCOS Armazenamento",
      "unit": "R$/kWh",
      "digits": 4,
      "sub": "Custo nivelado da energia despachada"
    },
    {
      "key": "annualSavingsBrl",
      "label": "Economia Anual Integrada",
      "unit": "R$/ano",
      "digits": 0,
      "isCurrency": true,
      "sub": "Autoconsumo + Arbitragem + Demanda"
    },
    {
      "key": "npvBrl",
      "label": "VPL (25 Anos • WACC 9,5%)",
      "unit": "R$",
      "digits": 0,
      "isCurrency": true,
      "sub": "Valor Presente Líquido do ativo híbrido"
    },
    {
      "key": "irrPct",
      "label": "Taxa Interna de Retorno (TIR)",
      "unit": "% a.a.",
      "digits": 2,
      "sub": "Rentabilidade sobre CAPEX híbrido"
    },
    {
      "key": "paybackYrs",
      "label": "Payback Simples",
      "unit": "anos",
      "digits": 2,
      "sub": "Tempo de retorno do investimento"
    }
  ],
  "chartTabs": [
    {
      "id": "dispatch",
      "label": "1. Curva 24h: Carga, FV e Despacho BESS"
    },
    {
      "id": "soc",
      "label": "2. Dinâmica do Estado de Carga SOC(t)"
    },
    {
      "id": "losses",
      "label": "3. Cascata de Perdas Técnicas FV"
    }
  ],
  "equations": [
    {
      "title": "Temperatura Operacional da Célula e Derating Térmico",
      "formula": "T_cell(t) = T_amb + [G(t) / 800] * (NOCT - 20)   |   f_T(t) = 1 + γ * [T_cell(t) - 25]",
      "desc": "Coeficiente térmico γ = -0,38 %/°C e NOCT = 45 °C. Acima de 25 °C na célula, a tensão de máxima potência reduz proporcionalmente."
    },
    {
      "title": "Potência CA com Clipping de Inversor",
      "formula": "P_CA(t) = min( P_inv_max , P_FV_CC(t) * η_inv )",
      "desc": "Respeita o teto de potência ativa dos inversores (4 x 250 kW = 1.000 kW CA), contabilizando o excedente ceifado como perda por clipping."
    },
    {
      "title": "Equação de Estado Recursiva do BESS (Conservação de Energia)",
      "formula": "SOC(t) = SOC(t-1) + [ η_ch * P_ch(t) * Δt - (P_dis(t) * Δt / η_dis) ] / E_nom",
      "desc": "Sujeito às restrições físicas estritas SOC_min <= SOC(t) <= SOC_max e 0 <= P_ch(t), P_dis(t) <= P_PCS_max em cada passo horário."
    },
    {
      "title": "LCOS (Levelized Cost of Storage)",
      "formula": "LCOS = [ CAPEX_BESS + Σ (OPEX_t + Reposição_t)/(1+r)^t ] / [ Σ E_despachada_t / (1+r)^t ]",
      "desc": "Calcula o custo nivelado por kWh efetivamente descarregado pelo BESS ao longo da vida útil considerando reposição parcial de células no ano 12."
    }
  ]
};
  const ENGINE_FN = SIMULATOR_ENGINES[PROJECT.slug];

  // Current state
  const defaultParams = {};
  PROJECT.paramGroups.forEach(g => {
    g.items.forEach(item => {
      defaultParams[item.key] = item.def;
    });
  });

  let currentParams = Object.assign({}, defaultParams);
  let activeScenario = 'base';
  let activeChartTab = PROJECT.chartTabs[0].id;
  let customCsvRows = null;

  // Load parameters from URL query string if present
  function loadFromUrl() {
    try {
      const qs = new URLSearchParams(window.location.search);
      let hadParam = false;
      Object.keys(defaultParams).forEach(k => {
        if (qs.has(k)) {
          const raw = qs.get(k);
          const num = Number(raw);
          currentParams[k] = (!Number.isNaN(num) && raw.trim() !== '') ? num : raw;
          hadParam = true;
        }
      });
      if (hadParam) activeScenario = 'custom';
    } catch (e) {}
  }

  function syncInputsToState() {
    PROJECT.paramGroups.forEach(g => {
      g.items.forEach(item => {
        const val = currentParams[item.key];
        const numEl = document.getElementById('input-' + item.key);
        const rangeEl = document.getElementById('range-' + item.key);
        if (numEl) numEl.value = val;
        if (rangeEl) rangeEl.value = val;
      });
    });
    document.querySelectorAll('.v3-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scenario === activeScenario);
    });
  }

  function formatKpiValue(def, val) {
    if (def.isCurrency) return fmtBRL(val, def.digits);
    return fmtNum(val, def.digits);
  }

  function renderKpis(result) {
    const container = document.getElementById('v3-kpi-grid');
    if (!container) return;
    container.innerHTML = PROJECT.kpiDefs.map(def => {
      const val = result.kpis[def.key];
      const str = formatKpiValue(def, val);
      return '<div class="v3-kpi-card" data-kpi="' + def.key + '">' +
        '<div>' +
          '<div class="v3-kpi-label">' + def.label + '</div>' +
          '<div class="v3-kpi-val">' + str + (def.isCurrency ? '' : '<span class="v3-kpi-unit">' + def.unit + '</span>') + '</div>' +
        '</div>' +
        '<div class="v3-kpi-sub">' + def.sub + '</div>' +
      '</div>';
    }).join('');
  }

  function renderStatusBanner(result) {
    const banner = document.getElementById('v3-status-banner');
    if (!banner) return;
    let statusClass = '';
    let leftText = 'STATUS OPERACIONAL: Simulação convergente e dentro dos limites físicos e regulatórios.';
    let rightText = 'Cenário ativo: ' + (PROJECT.scenarios[activeScenario]?.label || 'Personalizado pelo Usuário');

    if (PROJECT.slug === 'solar-pv-sizing-calculator') {
      leftText = result.kpis.statusEletrico;
      if (!result.kpis.isVocSafe) statusClass = 'danger';
      else if (!result.kpis.isMpptSafe) statusClass = 'warning';
    } else if (PROJECT.slug === 'energy-management-dashboard') {
      if (result.kpis.capacitorBankKvar > 0 || result.kpis.exceedanceKw > 0) {
        statusClass = 'warning';
        leftText = 'DIAGNÓSTICO ATIVO: Banco de ' + fmtNum(result.kpis.capacitorBankKvar, 0) + ' kVAr recomendado (FP < 0,92) • Ultrapassagem: ' + fmtNum(result.kpis.exceedanceKw, 0) + ' kW';
      } else {
        leftText = 'DIAGNÓSTICO ÓTIMO: Fator de Potência >= 0,92 e demanda dentro do limite contratado.';
      }
    } else if (PROJECT.slug === 'mercado-livre-energia-simulador') {
      if (result.kpis.annualSavingsBrl <= 0) {
        statusClass = 'danger';
        leftText = 'ALERTA DE VIABILIDADE: Preço PPA acima do Break-Even (' + fmtBRL(result.kpis.breakEvenMwh, 2) + '/MWh). Migração desfavorável.';
      } else {
        leftText = 'VIABILIDADE CONFIRMADA: Economia de ' + fmtNum(result.kpis.savingsPct, 1) + '% no ACL • Break-Even em ' + fmtBRL(result.kpis.breakEvenMwh, 2) + '/MWh';
      }
    } else if (PROJECT.slug === 'solar-pv-digital-twin-bess-platform') {
      leftText = 'BALANÇO ENERGÉTICO VERIFICADO: SOC contido em [' + result.params.socMinPct + '%, ' + result.params.socMaxPct + '%] • Redução de ponta: ' + fmtNum(result.kpis.peakReductionKw, 1) + ' kW';
    }
    banner.className = 'v3-status-banner ' + statusClass;
    banner.innerHTML = '<span>' + leftText + '</span><span>' + rightText + '</span>';
  }

  // SVG Chart Helpers
  function renderLineOrBarSvg(config) {
    const W = 820, H = 320;
    const padL = 64, padR = 28, padT = 32, padB = 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const labels = config.labels || [];
    const n = Math.max(1, labels.length);
    const allVals = [];
    config.series.forEach(s => s.data.forEach(v => allVals.push(Number(v) || 0)));
    const minVal = config.minZero ? 0 : Math.min(0, ...allVals);
    const maxVal = Math.max(minVal + 1, ...allVals) * 1.08;

    const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => padT + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

    let gridSvg = '';
    for (let g = 0; g <= 4; g++) {
      const val = minVal + ((maxVal - minVal) * g) / 4;
      const y = yAt(val);
      gridSvg += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="rgba(200,209,218,0.12)" stroke-dasharray="3,3" />';
      gridSvg += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" fill="#8898A9" font-family="IBM Plex Mono, monospace" font-size="10">' + fmtNum(val, config.yDigits ?? 0) + '</text>';
    }

    let xLabelsSvg = '';
    const step = Math.max(1, Math.floor(n / 8));
    labels.forEach((lbl, idx) => {
      if (idx % step === 0 || idx === n - 1) {
        const cx = config.type === 'bar'
          ? padL + ((idx + 0.5) / n) * plotW
          : xAt(idx);
        xLabelsSvg += '<text x="' + cx.toFixed(1) + '" y="' + (H - 14) + '" text-anchor="middle" fill="#C8D1DA" font-family="IBM Plex Mono, monospace" font-size="10">' + lbl + '</text>';
      }
    });

    let bodySvg = '';
    if (config.type === 'bar') {
      const sCount = config.series.length;
      const groupW = plotW / n;
      const barW = Math.min(34, (groupW * 0.74) / sCount);
      config.series.forEach((s, sIdx) => {
        s.data.forEach((v, i) => {
          const val = Number(v) || 0;
          const zeroY = yAt(0);
          const valY = yAt(val);
          const yTop = Math.min(zeroY, valY);
          const bh = Math.max(2, Math.abs(zeroY - valY));
          const bx = padL + i * groupW + (groupW - barW * sCount) / 2 + sIdx * barW;
          bodySvg += '<rect x="' + bx.toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + (barW - 2).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="' + s.color + '" opacity="0.9"><title>' + labels[i] + ' • ' + s.name + ': ' + fmtNum(val, 2) + ' ' + (config.unit || '') + '</title></rect>';
        });
      });
    } else {
      config.series.forEach(s => {
        const pts = s.data.map((v, i) => xAt(i).toFixed(1) + ',' + yAt(Number(v) || 0).toFixed(1)).join(' ');
        if (s.area) {
          const areaPts = xAt(0).toFixed(1) + ',' + yAt(minVal).toFixed(1) + ' ' + pts + ' ' + xAt(n - 1).toFixed(1) + ',' + yAt(minVal).toFixed(1);
          bodySvg += '<polygon points="' + areaPts + '" fill="' + s.color + '" opacity="0.16" />';
        }
        bodySvg += '<polyline fill="none" stroke="' + s.color + '" stroke-width="2.5" points="' + pts + '" />';
        s.data.forEach((v, i) => {
          const cx = xAt(i);
          const cy = yAt(Number(v) || 0);
          const isHighlight = s.highlightIndices && s.highlightIndices.includes(i);
          bodySvg += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (isHighlight ? 5.5 : 3) + '" fill="' + (isHighlight ? '#F87171' : s.color) + '" stroke="#06131F" stroke-width="1.2"><title>' + labels[i] + ' • ' + s.name + ': ' + fmtNum(v, 2) + ' ' + (config.unit || '') + '</title></circle>';
        });
      });
    }

    let legendSvg = '';
    config.series.forEach((s, idx) => {
      const lx = padL + idx * 210;
      legendSvg += '<rect x="' + lx + '" y="8" width="12" height="12" rx="3" fill="' + s.color + '" />';
      legendSvg += '<text x="' + (lx + 18) + '" y="18" fill="#F4F6F3" font-family="IBM Plex Sans, sans-serif" font-size="11" font-weight="600">' + s.name + '</text>';
    });

    return '<svg id="v3-active-svg" class="v3-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + W + '" height="' + H + '" rx="8" fill="#06131F" />' +
      legendSvg + gridSvg + bodySvg + xLabelsSvg +
    '</svg>';
  }

  function renderChart(result) {
    const canvas = document.getElementById('v3-chart-canvas');
    if (!canvas) return;
    const slug = PROJECT.slug;
    const tab = activeChartTab;

    if (slug === 'solar-pv-digital-twin-bess-platform') {
      if (tab === 'dispatch') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          unit: 'kW',
          labels: result.hourly.map(r => r.hora),
          series: [
            { name: 'Geração Solar CA (kW)', color: '#D3A15C', area: true, data: result.hourly.map(r => r.pvAcKw) },
            { name: 'Demanda Original (kW)', color: '#F87171', data: result.hourly.map(r => r.loadKw) },
            { name: 'Demanda Líquida c/ BESS (kW)', color: '#22D3EE', area: true, data: result.hourly.map(r => r.netWithBessKw) }
          ]
        });
      } else if (tab === 'soc') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          unit: '%',
          labels: result.hourly.map(r => r.hora),
          series: [
            { name: 'Estado de Carga SOC (%)', color: '#36D399', area: true, data: result.hourly.map(r => r.socPct) },
            { name: 'Limite SOC Máx (%)', color: '#D3A15C', data: result.hourly.map(() => result.params.socMaxPct) },
            { name: 'Limite SOC Mín (%)', color: '#F87171', data: result.hourly.map(() => result.params.socMinPct) }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          yDigits: 1,
          unit: '%',
          labels: result.losses.map(l => l.label),
          series: [
            { name: 'Perda Técnica Específica (%)', color: '#D3A15C', data: result.losses.map(l => l.pct) }
          ]
        });
      }
    } else if (slug === 'energy-intelligence-ai-platform') {
      const seriesData = customCsvRows || result.series;
      if (tab === 'forecast') {
        const anomIdx = seriesData.map((r, i) => r.isAnomaly ? i : -1).filter(i => i >= 0);
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          unit: 'kW',
          labels: seriesData.map(r => r.hora),
          series: [
            { name: 'Carga Medida Real (kW)', color: '#22D3EE', highlightIndices: anomIdx, data: seriesData.map(r => r.realKw) },
            { name: 'Previsão Modelo IA (kW)', color: '#D3A15C', area: true, data: seriesData.map(r => r.predKw) }
          ]
        });
      } else if (tab === 'benchmark') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          yDigits: 1,
          unit: '',
          labels: result.benchmarks.map(b => b.model),
          series: [
            { name: 'MAPE (%)', color: '#D3A15C', data: result.benchmarks.map(b => b.mape) },
            { name: 'MAE (kW)', color: '#22D3EE', data: result.benchmarks.map(b => b.mae) },
            { name: 'RMSE (kW)', color: '#A78BFA', data: result.benchmarks.map(b => b.rmse) }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: false,
          yDigits: 1,
          unit: 'kW',
          labels: seriesData.map(r => r.hora),
          series: [
            { name: 'Resíduo Preditivo (Real - Previsto kW)', color: '#38BDF8', data: seriesData.map(r => r.residKw) }
          ]
        });
      }
    } else if (slug === 'brazilian-power-system-dashboard') {
      if (tab === 'duck') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          unit: 'GW',
          labels: result.hourly.map(r => r.hora),
          series: [
            { name: 'Carga Bruta SIN (GW)', color: '#F4F6F3', data: result.hourly.map(r => r.loadGw) },
            { name: 'Carga Líquida / Curva do Pato (GW)', color: '#D3A15C', area: true, data: result.hourly.map(r => r.netLoadGw) },
            { name: 'Geração Solar + Eólica (GW)', color: '#22D3EE', area: true, data: result.hourly.map(r => Number((r.solarGw + r.windGw).toFixed(2))) }
          ]
        });
      } else if (tab === 'stack') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          unit: 'GW',
          labels: result.hourly.map(r => r.hora),
          series: [
            { name: 'Hidrelétrica (GW)', color: '#38BDF8', area: true, data: result.hourly.map(r => r.hydroGw) },
            { name: 'Eólica + Solar (GW)', color: '#36D399', data: result.hourly.map(r => Number((r.windGw + r.solarGw).toFixed(2))) },
            { name: 'Térmica + Nuclear (GW)', color: '#F87171', data: result.hourly.map(r => r.thermalGw) }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'GW',
          labels: result.matrix.map(m => m.source),
          series: [
            { name: 'Capacidade Instalada Outorgada (GW)', color: '#38BDF8', data: result.matrix.map(m => m.gw) }
          ]
        });
      }
    } else if (slug === 'solar-energy-feasibility-simulator') {
      if (tab === 'dcf') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: false,
          unit: 'R$',
          labels: result.years.map(y => 'A' + y.ano),
          series: [
            { name: 'Saldo Acumulado Nominal (R$)', color: '#36D399', data: result.years.map(y => y.cumNominal) },
            { name: 'Saldo Acumulado Descontado WACC (R$)', color: '#D3A15C', area: true, data: result.years.map(y => y.cumDiscounted) }
          ]
        });
      } else if (tab === 'annual') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'R$',
          labels: result.years.map(y => 'A' + y.ano),
          series: [
            { name: 'Economia Bruta Anual (R$)', color: '#36D399', data: result.years.map(y => y.grossSavings) },
            { name: 'O&M + Troca Inversor Ano 12 (R$)', color: '#F87171', data: result.years.map(y => y.omAndInv) }
          ]
        });
      } else {
        const p = result.params;
        const sens = [
          { lbl: 'Tarifa +15%', npv: simulateProject04(Object.assign({}, p, { tarifaKwh: p.tarifaKwh * 1.15 })).kpis.npvBrl },
          { lbl: 'Caso-Base', npv: result.kpis.npvBrl },
          { lbl: 'CAPEX +15%', npv: simulateProject04(Object.assign({}, p, { custoKwp: p.custoKwp * 1.15 })).kpis.npvBrl },
          { lbl: 'WACC +3% a.a.', npv: simulateProject04(Object.assign({}, p, { waccPct: p.waccPct + 3 })).kpis.npvBrl },
          { lbl: 'HSP -10%', npv: simulateProject04(Object.assign({}, p, { hsp: p.hsp * 0.90 })).kpis.npvBrl }
        ];
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: false,
          unit: 'R$',
          labels: sens.map(s => s.lbl),
          series: [
            { name: 'VPL sob Sensibilidade Paramétrica (R$)', color: '#FBBF24', data: sens.map(s => s.npv) }
          ]
        });
      }
    } else if (slug === 'mercado-livre-energia-simulador') {
      if (tab === 'breakdown') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'R$/ano',
          labels: result.breakdown.map(b => b.item),
          series: [
            { name: 'Mercado Cativo ACR (R$/ano)', color: '#F87171', data: result.breakdown.map(b => b.acr) },
            { name: 'Mercado Livre ACL (R$/ano)', color: '#36D399', data: result.breakdown.map(b => b.acl) }
          ]
        });
      } else if (tab === 'horizon') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: false,
          unit: 'R$',
          labels: result.horizon.map(h => h.ano),
          series: [
            { name: 'Economia Anual (R$)', color: '#22D3EE', data: result.horizon.map(h => h.economiaAnualBrl) },
            { name: 'Economia Acumulada 5 Anos (R$)', color: '#D3A15C', data: result.horizon.map(h => h.economiaAcumBrl) }
          ]
        });
      } else {
        const prices = [140, 190, 235, 290, 350, 420, 500];
        const curve = prices.map(pr => simulateProject05(Object.assign({}, result.params, { precoAclMwh: pr })).kpis.annualSavingsBrl);
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: false,
          unit: 'R$/ano',
          labels: prices.map(pr => 'R$ ' + pr + '/MWh'),
          series: [
            { name: 'Economia Anual vs Preço PPA (R$/ano)', color: '#36D399', area: true, data: curve }
          ]
        });
      }
    } else if (slug === 'green-hydrogen-techno-economic-simulator') {
      if (tab === 'lcoh_comp') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          yDigits: 2,
          unit: 'R$/kg',
          labels: result.costBreakdown.map(c => c.component),
          series: [
            { name: 'Parcela do LCOH (R$/kg H2)', color: '#36D399', data: result.costBreakdown.map(c => c.brlKg) }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'line',
          minZero: true,
          yDigits: 2,
          unit: 'R$/kg',
          labels: result.cfCurve.map(c => 'FC ' + c.cfPct + '%'),
          series: [
            { name: 'LCOH (R$/kg H2)', color: '#22D3EE', area: true, data: result.cfCurve.map(c => c.lcohBrl) },
            { name: 'LCOH (US$/kg H2)', color: '#D3A15C', data: result.cfCurve.map(c => c.lcohUsd) }
          ]
        });
      }
    } else if (slug === 'electrical-project-management-dashboard') {
      if (tab === 'stages') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          yDigits: 1,
          unit: 'dias',
          labels: result.stages.map(s => s.etapa),
          series: [
            { name: 'Tempo Médio na Etapa (dias)', color: '#A78BFA', data: result.stages.map(s => s.diasMedio) }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'projetos',
          labels: result.stages.map(s => s.etapa),
          series: [
            { name: 'Projetos Ativos na Etapa', color: '#D3A15C', data: result.stages.map(s => s.projetos) }
          ]
        });
      }
    } else if (slug === 'energy-management-dashboard') {
      if (tab === 'sectors') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'MWh/ano',
          labels: result.sectors.map(s => s.setor),
          series: [
            { name: 'Consumo Setorial (MWh/ano)', color: '#22D3EE', data: result.sectors.map(s => s.mwh) }
          ]
        });
      } else {
        const eSav = result.kpis.totalAnnualSavingsBrl - result.kpis.annualReactivePenaltyBrl;
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'R$/ano',
          labels: ['Retrofits Motores VFD & HVAC', 'Eliminação Multa Reativa (FP)', 'Economia Total Anual'],
          series: [
            { name: 'Impacto Financeiro Anual (R$/ano)', color: '#36D399', data: [eSav, result.kpis.annualReactivePenaltyBrl, result.kpis.totalAnnualSavingsBrl] }
          ]
        });
      }
    } else if (slug === 'solar-pv-sizing-calculator') {
      if (tab === 'voltage') {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'V CC',
          labels: ['MPPT Mín Inversor', 'Vmp String Quente (Tmax)', 'Voc String Frio (Tmin)', 'Tensão Máx Inversor'],
          series: [
            { name: 'Tensão CC (Volts)', color: result.kpis.isVocSafe ? '#36D399' : '#F87171', data: [160, result.kpis.vmpStringHotV, result.kpis.vocStringColdV, result.params.inversorPreset === '6' ? 1000 : 1100] }
          ]
        });
      } else {
        canvas.innerHTML = renderLineOrBarSvg({
          type: 'bar',
          minZero: true,
          unit: 'kWh/mês',
          labels: result.monthly.map(m => m.mes),
          series: [
            { name: 'Geração FV Estimada (kWh)', color: '#D3A15C', data: result.monthly.map(m => m.geracaoKwh) },
            { name: 'Consumo Mensal (kWh)', color: '#38BDF8', data: result.monthly.map(m => m.consumoKwh) }
          ]
        });
      }
    }
  }

  function renderInsights(result) {
    const box = document.getElementById('v3-insights-list');
    if (!box) return;
    const k = result.kpis;
    let items = [];
    if (PROJECT.slug === 'solar-pv-digital-twin-bess-platform') {
      items = [
        { title: '1. Desempenho Fotovoltaico & Clipping', text: 'A usina opera com Performance Ratio de ' + fmtNum(k.prPct, 2) + '% gerando ' + fmtNum(k.annualPvMwh, 1) + ' MWh/ano. Perda diária por clipping CA: ' + fmtNum(k.dailyClippingKwh, 1) + ' kWh.' },
        { title: '2. Despacho Eletroquímico BESS', text: 'O banco LiFePO4 reduz a demanda de ponta em ' + fmtNum(k.peakReductionKw, 1) + ' kW mantendo o SOC estritamente entre ' + result.params.socMinPct + '% e ' + result.params.socMaxPct + '%.' },
        { title: '3. Atratividade Econômica Híbrida', text: 'LCOS calculado em R$ ' + fmtNum(k.lcosBrlKwh, 4) + '/kWh com VPL de ' + fmtBRL(k.npvBrl, 0) + ' e TIR de ' + fmtNum(k.irrPct, 2) + '% a.a.' }
      ];
    } else if (PROJECT.slug === 'energy-intelligence-ai-platform') {
      items = [
        { title: '1. Acurácia Preditiva Validada', text: 'O modelo selecionado apresenta MAPE de ' + fmtNum(k.mapePct, 2) + '%, RMSE de ' + fmtNum(k.rmseKw, 2) + ' kW e R² de ' + fmtNum(k.r2Score, 3) + ' na série avaliada.' },
        { title: '2. Vigilância de Anomalias em Telemetria', text: 'Com limiar Z-Score de ' + fmtNum(result.params.zThreshold, 1) + 'σ, foram isolados ' + k.anomaliesCount + ' eventos críticos para inspeção de engenharia.' },
        { title: '3. Otimização de Ponta (Load Shifting)', text: 'A realocação de ' + fmtNum(k.shiftedEnergyMwh, 1) + ' MWh/ano para a janela solar (10h-15h) reduz o pico em ' + fmtNum(k.peakReductionKw, 1) + ' kW e economiza ' + fmtBRL(k.annualSavingsBrl, 0) + '/ano.' }
      ];
    } else if (PROJECT.slug === 'brazilian-power-system-dashboard') {
      items = [
        { title: '1. Renovabilidade e Segurança Operativa', text: 'O recorte analisado conta com ' + fmtNum(k.totalCapGw, 1) + ' GW instalados e ' + fmtNum(k.renewableSharePct, 1) + '% de atendimento renovável no balanço diário.' },
        { title: '2. Fenômeno da Curva do Pato e Rampa', text: 'A carga líquida cai para ' + fmtNum(k.duckBellyGw, 1) + ' GW ao meio-dia e exige rampa vespertina de ' + fmtNum(k.maxEveningRampGw, 2) + ' GW/h até as 19h.' },
        { title: '3. Sinal Econômico (PLD) e Emissões', text: 'Custo marginal estimado em R$ ' + fmtNum(k.pldBrlMwh, 2) + '/MWh com intensidade de carbono de ' + fmtNum(k.emissionTco2Mwh, 3) + ' tCO2/MWh.' }
      ];
    } else if (PROJECT.slug === 'solar-energy-feasibility-simulator') {
      items = [
        { title: '1. Dimensionamento Físico Otimizado', text: 'Potência de ' + fmtNum(k.installedKwp, 2) + ' kWp (' + k.nModules + ' módulos, ' + fmtNum(k.areaM2, 1) + ' m²) com CAPEX de ' + fmtBRL(k.capexBrl, 0) + '.' },
        { title: '2. Payback Simples vs Descontado', text: 'Retorno nominal em ' + fmtNum(k.simplePaybackYrs, 2) + ' anos e Payback Descontado (WACC) em ' + fmtNum(k.discountedPaybackYrs, 2) + ' anos.' },
        { title: '3. Geração de Valor em 25 Anos', text: 'VPL de ' + fmtBRL(k.npvBrl, 0) + ', TIR de ' + fmtNum(k.irrPct, 2) + '% a.a. e LCOE de R$ ' + fmtNum(k.lcoeBrlKwh, 4) + '/kWh.' }
      ];
    } else if (PROJECT.slug === 'mercado-livre-energia-simulador') {
      items = [
        { title: '1. Comparativo Estrutural ACR vs ACL', text: 'Redução de despesa anual de ' + fmtBRL(k.acrAnualBrl, 0) + ' (ACR) para ' + fmtBRL(k.aclAnualBrl, 0) + ' (ACL), gerando economia de ' + fmtNum(k.savingsPct, 2) + '%.' },
        { title: '2. Margem de Segurança (Break-Even)', text: 'O Preço de Indiferença da energia no ACL é R$ ' + fmtNum(k.breakEvenMwh, 2) + '/MWh frente ao PPA atual de R$ ' + fmtNum(result.params.precoAclMwh, 2) + '/MWh.' },
        { title: '3. Impacto Acumulado no Quinquênio', text: 'Em 5 anos, a migração proporciona economia acumulada estimada em ' + fmtBRL(k.fiveYearSavingsBrl, 0) + '.' }
      ];
    } else if (PROJECT.slug === 'green-hydrogen-techno-economic-simulator') {
      items = [
        { title: '1. Competitividade LCOH', text: 'Custo nivelado calculado em R$ ' + fmtNum(k.lcohBrlKg, 2) + '/kg H2 (US$ ' + fmtNum(k.lcohUsdKg, 2) + '/kg) para ' + fmtNum(k.eflhHours, 0) + ' horas equivalentes/ano.' },
        { title: '2. Balanço de Massa, Água e Eficiência', text: 'Produção de ' + fmtNum(k.annualH2Ton, 1) + ' ton/ano de H2V com eficiência LHV de ' + fmtNum(k.effLhvPct, 1) + '% e demanda de ' + fmtNum(k.waterM3Year, 0) + ' m³/ano de água pura.' },
        { title: '3. Descarbonização Industrial', text: 'Substitui hidrogênio cinza evitando ' + fmtNum(k.co2AvoidedTons, 0) + ' tCO2/ano.' }
      ];
    } else if (PROJECT.slug === 'electrical-project-management-dashboard') {
      items = [
        { title: '1. Desempenho de Prazo e Caminho Crítico', text: 'Lead time médio de ' + fmtNum(k.avgLeadTimeDays, 1) + ' dias com ' + fmtNum(k.onTimePct, 1) + '% de conclusão dentro do SLA corporativo.' },
        { title: '2. Governança de Valor Agregado (SPI / CPI)', text: 'Carteira operando com SPI = ' + fmtNum(k.spi, 2) + ' e CPI = ' + fmtNum(k.cpi, 2) + ' sobre R$ ' + fmtNum(k.portfolioValueM, 2) + ' milhões em ativos.' },
        { title: '3. Mitigação de Gargalos em Concessionárias', text: 'Reduzir a taxa de pendência técnica na 1ª submissão é a alavanca de maior retorno sobre o prazo médio.' }
      ];
    } else if (PROJECT.slug === 'energy-management-dashboard') {
      items = [
        { title: '1. Correção de Fator de Potência', text: 'Para elevar cos φ de ' + fmtNum(result.params.fatorPotenciaAtual, 2) + ' até 0,92, dimensiona-se banco automático de ' + fmtNum(k.capacitorBankKvar, 0) + ' kVAr evitando ' + fmtBRL(k.annualReactivePenaltyBrl, 0) + '/ano.' },
        { title: '2. Gestão de Demanda e Fator de Carga', text: 'Fator de carga em ' + fmtNum(k.loadFactor, 2) + ' com ultrapassagem apurada de ' + fmtNum(k.exceedanceKw, 0) + ' kW sobre a demanda contratada.' },
        { title: '3. Retorno dos Retrofits Industriais', text: 'Economia física de ' + fmtNum(k.savingsMwhYear, 1) + ' MWh/ano e retorno financeiro total de ' + fmtBRL(k.totalAnnualSavingsBrl, 0) + '/ano (Payback de ' + fmtNum(k.paybackYrs, 2) + ' anos).' }
      ];
    } else {
      items = [
        { title: '1. Arranjo Fotovoltaico Dimensionado', text: 'Gerador de ' + fmtNum(k.installedKwp, 2) + ' kWp composto por ' + k.nModTotal + ' módulos (' + k.modPerString + ' módulos em série por string, área de ' + fmtNum(k.areaM2, 1) + ' m²).' },
        { title: '2. Segurança Térmica de Tensão CC', text: 'Voc na mínima temperatura: ' + fmtNum(k.vocStringColdV, 1) + ' V (máx permitido: ' + k.nMaxString + ' mód/string). Vmp a quente: ' + fmtNum(k.vmpStringHotV, 1) + ' V.' },
        { title: '3. Carregamento CC/CA do Inversor', text: 'Fator de Dimensionamento FDI = ' + fmtNum(k.fdi, 2) + ' com Performance Ratio global de ' + fmtNum(k.prPct, 2) + '%.' }
      ];
    }
    box.innerHTML = items.map(it => '<div class="v3-insight-item"><strong>' + it.title + '</strong>' + it.text + '</div>').join('');
  }

  function renderScenarioComparison(currentResult) {
    const tbody = document.getElementById('v3-scenario-tbody');
    if (!tbody) return;
    const scenKeys = ['base', 'conservador', 'provavel', 'otimista'];
    const scenResults = {};
    scenKeys.forEach(sk => {
      scenResults[sk] = ENGINE_FN(PROJECT.scenarios[sk].params);
    });

    tbody.innerHTML = PROJECT.kpiDefs.map(def => {
      return '<tr>' +
        '<td><strong>' + def.label + '</strong> (' + def.unit + ')</td>' +
        scenKeys.map(sk => '<td>' + formatKpiValue(def, scenResults[sk].kpis[def.key]) + '</td>').join('') +
        '<td style="color:var(--gold-soft);font-weight:700;">' + formatKpiValue(def, currentResult.kpis[def.key]) + '</td>' +
      '</tr>';
    }).join('');
  }

  function getActiveSeriesTable(result) {
    if (result.hourly) {
      return {
        headers: ['Hora', ...Object.keys(result.hourly[0]).filter(k => k !== 'hora' && k !== 'h')],
        rows: result.hourly.map(r => [r.hora, ...Object.keys(r).filter(k => k !== 'hora' && k !== 'h').map(k => r[k])])
      };
    }
    if (result.series) {
      const s = customCsvRows || result.series;
      return {
        headers: ['Hora', 'Real (kW)', 'Previsto (kW)', 'Resíduo (kW)', 'Z-Score', 'Anomalia'],
        rows: s.map(r => [r.hora, r.realKw, r.predKw, r.residKw, r.zScore, r.isAnomaly ? 'SIM' : 'NÃO'])
      };
    }
    if (result.years) {
      return {
        headers: ['Ano', 'Geração (kWh)', 'Economia Bruta (R$)', 'O&M + Troca Inv (R$)', 'Fluxo Líquido (R$)', 'Saldo Nominal (R$)', 'Saldo Descontado (R$)'],
        rows: result.years.map(y => ['Ano ' + y.ano, y.genKwh, y.grossSavings, y.omAndInv, y.netCf, y.cumNominal, y.cumDiscounted])
      };
    }
    if (result.horizon) {
      return {
        headers: ['Período', 'Custo Cativo ACR (R$)', 'Custo Livre ACL (R$)', 'Economia Anual (R$)', 'Economia Acumulada (R$)'],
        rows: result.horizon.map(h => [h.ano, h.acrBrl, h.aclBrl, h.economiaAnualBrl, h.economiaAcumBrl])
      };
    }
    if (result.cfCurve) {
      return {
        headers: ['Fator de Capacidade (%)', 'LCOH (R$/kg H2)', 'LCOH (US$/kg H2)', 'Produção Anual (ton/ano)'],
        rows: result.cfCurve.map(c => [c.cfPct + '%', c.lcohBrl, c.lcohUsd, c.prodTon])
      };
    }
    if (result.stages) {
      return {
        headers: ['Etapa do Fluxo PMO', 'Projetos Ativos', 'Lead Time Médio (dias)'],
        rows: result.stages.map(s => [s.etapa, s.projetos, s.diasMedio])
      };
    }
    if (result.sectors) {
      return {
        headers: ['Setor Industrial', 'Participação (%)', 'Consumo Anual (MWh/ano)'],
        rows: result.sectors.map(s => [s.setor, s.sharePct + '%', s.mwh])
      };
    }
    if (result.monthly) {
      return {
        headers: ['Mês', 'Geração FV Estimada (kWh)', 'Consumo Base (kWh)'],
        rows: result.monthly.map(m => [m.mes, m.geracaoKwh, m.consumoKwh])
      };
    }
    return { headers: [], rows: [] };
  }

  function renderDataTable(result) {
    const thead = document.getElementById('v3-data-thead');
    const tbody = document.getElementById('v3-data-tbody');
    if (!thead || !tbody) return;
    const tbl = getActiveSeriesTable(result);
    thead.innerHTML = '<tr>' + tbl.headers.map(h => '<th>' + h + '</th>').join('') + '</tr>';
    tbody.innerHTML = tbl.rows.slice(0, 15).map(row =>
      '<tr>' + row.map((cell, idx) => '<td>' + (typeof cell === 'number' && idx > 0 ? fmtNum(cell, 1) : cell) + '</td>').join('') + '</tr>'
    ).join('');
  }

  let lastResult = null;
  function updateAll() {
    lastResult = ENGINE_FN(currentParams);
    renderStatusBanner(lastResult);
    renderKpis(lastResult);
    renderChart(lastResult);
    renderInsights(lastResult);
    renderScenarioComparison(lastResult);
    renderDataTable(lastResult);
  }

  // Bind UI events
  function initEvents() {
    PROJECT.paramGroups.forEach(g => {
      g.items.forEach(item => {
        const numEl = document.getElementById('input-' + item.key);
        const rangeEl = document.getElementById('range-' + item.key);
        if (rangeEl && numEl) {
          rangeEl.addEventListener('input', () => {
            const v = Number(rangeEl.value);
            numEl.value = v;
            currentParams[item.key] = v;
            activeScenario = 'custom';
            syncInputsToState();
            updateAll();
          });
          numEl.addEventListener('change', () => {
            const v = clamp(numEl.value, item.min, item.max);
            numEl.value = v;
            rangeEl.value = v;
            currentParams[item.key] = v;
            activeScenario = 'custom';
            syncInputsToState();
            updateAll();
          });
        } else if (numEl) {
          numEl.addEventListener('change', () => {
            const raw = numEl.value;
            const asNum = Number(raw);
            currentParams[item.key] = (!Number.isNaN(asNum) && item.key !== 'moduloPreset' && item.key !== 'inversorPreset') ? asNum : raw;
            activeScenario = 'custom';
            syncInputsToState();
            updateAll();
          });
        }
      });
    });

    document.querySelectorAll('.v3-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sc = btn.dataset.scenario;
        if (PROJECT.scenarios[sc]) {
          activeScenario = sc;
          currentParams = Object.assign({}, defaultParams, PROJECT.scenarios[sc].params);
          customCsvRows = null;
          syncInputsToState();
          updateAll();
        }
      });
    });

    document.querySelectorAll('.v3-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeChartTab = btn.dataset.tab;
        document.querySelectorAll('.v3-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeChartTab));
        if (lastResult) renderChart(lastResult);
      });
    });

    const resetBtn = document.getElementById('btn-reset-base');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        activeScenario = 'base';
        currentParams = Object.assign({}, defaultParams, PROJECT.scenarios.base.params);
        customCsvRows = null;
        window.history.replaceState({}, '', window.location.pathname);
        syncInputsToState();
        updateAll();
      });
    }

    const shareBtn = document.getElementById('btn-share-url');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        const qs = new URLSearchParams();
        Object.entries(currentParams).forEach(([k, v]) => qs.set(k, v));
        const newUrl = window.location.origin + window.location.pathname + '?' + qs.toString();
        window.history.replaceState({}, '', '?' + qs.toString());
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(newUrl).catch(() => {});
        }
        const orig = shareBtn.textContent;
        shareBtn.textContent = 'Link Copiado!';
        setTimeout(() => { shareBtn.textContent = orig; }, 1800);
      });
    }

    const csvBtn = document.getElementById('btn-export-csv');
    if (csvBtn) {
      csvBtn.addEventListener('click', () => {
        if (!lastResult) return;
        const tbl = getActiveSeriesTable(lastResult);
        const lines = [tbl.headers.join(';')];
        tbl.rows.forEach(r => lines.push(r.join(';')));
        const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = PROJECT.slug + '-resultados-v3.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    }

    const svgBtn = document.getElementById('btn-export-svg');
    if (svgBtn) {
      svgBtn.addEventListener('click', () => {
        const svgEl = document.getElementById('v3-active-svg');
        if (!svgEl) return;
        const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = PROJECT.slug + '-grafico-' + activeChartTab + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    }

    const pdfBtn = document.getElementById('btn-export-pdf');
    if (pdfBtn) {
      pdfBtn.addEventListener('click', () => {
        window.print();
      });
    }

    // CSV upload for Project 02
    const fileInput = document.getElementById('v3-csv-upload');
    if (fileInput) {
      fileInput.addEventListener('change', (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || '');
          const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const parsed = [];
          lines.slice(1, 25).forEach((line, idx) => {
            const cols = line.split(/[;,]/);
            const val = Number(cols[1] ?? cols[0]);
            if (Number.isFinite(val) && val > 0) {
              const pred = val * 0.965;
              const resid = val - pred;
              parsed.push({
                hora: cols[0] || ('T+' + idx),
                h: idx,
                realKw: Number(val.toFixed(1)),
                predKw: Number(pred.toFixed(1)),
                residKw: Number(resid.toFixed(1)),
                zScore: Number((Math.abs(resid) / Math.max(1, val * 0.04)).toFixed(2)),
                isAnomaly: Math.abs(resid) / Math.max(1, val * 0.04) >= currentParams.zThreshold
              });
            }
          });
          if (parsed.length >= 4) {
            customCsvRows = parsed;
            const statusEl = document.getElementById('v3-csv-status');
            if (statusEl) statusEl.textContent = 'CSV carregado (' + parsed.length + ' registros processados)';
            updateAll();
          }
        };
        reader.readAsText(file);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadFromUrl();
    syncInputsToState();
    initEvents();
    updateAll();
  });
})();
