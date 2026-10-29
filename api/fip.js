const cheerio = require("cheerio");

const BASE_FIP_URL =
  "https://fip.it/risultati/?group=campionati-regionali&regione_codice=LO&comitato_codice=PVA&sesso=M&codice_campionato=2DM&codice_fase=1&codice_girone=85812";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9"
};

const MONTHS_IT = {
  gennaio: "01",
  febbraio: "02",
  marzo: "03",
  aprile: "04",
  maggio: "05",
  giugno: "06",
  luglio: "07",
  agosto: "08",
  settembre: "09",
  ottobre: "10",
  novembre: "11",
  dicembre: "12"
};

const INFO_LABELS = [
  { key: "homeTeam", regex: /^Squadra di casa$/i },
  { key: "awayTeam", regex: /^Squadra ospite$/i },
  { key: "gym", regex: /^Campo di gioco$/i },
  { key: "ref1", regex: /^1\s*[^\w\s]?\s*Arbitro$/i },
  { key: "ref2", regex: /^2\s*[^\w\s]?\s*Arbitro$/i },
  { key: "ref3", regex: /^3\s*[^\w\s]?\s*Arbitro$/i },
  { key: "refGeneric", regex: /^Arbitr[oi]$/i },
  { key: "stop", regex: /^(Segnapunti|Cronometrista|24\s*secondi|Osservatore)$/i }
];

let CACHE = { timestamp: 0, data: null };

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`FIP.it HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isCmbTeam(name) {
  if (!name) return false;
  const u = name.toUpperCase();
  return (
    u.includes("RHO") &&
    (u.includes("C.M.B") || u.includes("CMB") || u.includes("CENTRO MINI BASKET"))
  );
}

function normalizeTeamKey(name) {
  return (name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseStandings($) {
  const standings = [];
  $("table tr").each((_, row) => {
    const cols = [];
    $(row)
      .find("td")
      .each((__, td) => {
        cols.push($(td).text().replace(/\s+/g, " ").trim());
      });

    if (cols.length >= 5) {
      const firstIsNum = /^\d+$/.test(cols[0]);
      const idxOffset = firstIsNum ? 1 : 0;
      const team = cols[idxOffset];
      const points = parseInt(cols[idxOffset + 1], 10);
      const played = parseInt(cols[idxOffset + 2], 10) || 0;
      const won = parseInt(cols[idxOffset + 3], 10) || 0;
      const lost = parseInt(cols[idxOffset + 4], 10) || 0;
      const pfCol = parseInt(cols[idxOffset + 5], 10);
      const psCol = parseInt(cols[idxOffset + 6], 10);

      if (
        team &&
        !/^\d+$/.test(team) &&
        !team.includes("Sede:") &&
        !team.includes("Campo da gioco:") &&
        !isNaN(points) &&
        standings.length < 16
      ) {
        standings.push({
          position: firstIsNum ? parseInt(cols[0], 10) : standings.length + 1,
          team,
          points,
          played,
          won,
          lost,
          pf: !isNaN(pfCol) ? pfCol : 0,
          ps: !isNaN(psCol) ? psCol : 0,
          diff: !isNaN(pfCol) && !isNaN(psCol) ? pfCol - psCol : 0,
          isCmb: isCmbTeam(team)
        });
      }
    }
  });
  return standings;
}

function getTokens($) {
  const tokens = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "text") {
      const t = $(node).text().replace(/\s+/g, " ").trim();
      if (t) tokens.push(t);
    } else if (
      node.type === "tag" &&
      !["script", "style", "noscript"].includes(node.name)
    ) {
      $(node)
        .contents()
        .each((_, child) => walk(child));
    }
  }
  walk($("body")[0]);
  return tokens;
}

function matchLabel(token) {
  for (const item of INFO_LABELS) {
    if (item.regex.test(token)) return item.key;
  }
  return null;
}

function dateToComparableNum(dateStr) {
  const m = (dateStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return 99999999;
  return parseInt(`${m[3]}${m[2]}${m[1]}`, 10);
}

function parseMatches(tokens, roundLabel, roundKey) {
  const matches = [];

  for (let i = 0; i < tokens.length; i++) {
    if (!/^Squadra di casa$/i.test(tokens[i])) continue;

    const info = {
      homeTeam: [],
      awayTeam: [],
      gym: [],
      ref1: [],
      ref2: [],
      ref3: [],
      refGeneric: []
    };

    let currentKey = "homeTeam";
    for (let k = i + 1; k < Math.min(tokens.length, i + 30); k++) {
      const tok = tokens[k];
      if (/^Squadra di casa$/i.test(tok) || /^Info$/i.test(tok)) break;

      const lbl = matchLabel(tok);
      if (lbl) {
        if (lbl === "stop") break;
        currentKey = lbl;
        continue;
      }

      if (currentKey && info[currentKey]) {
        info[currentKey].push(tok);
        if (currentKey === "refGeneric") break;
        if (currentKey === "gym" && info.gym.length >= 1) {
          currentKey = null;
        }
      }
    }

    let dateStr = "Data da definire";
    let timeStr = "--:--";
    let matchCode = "";
    const scores = [];

    for (let b = i - 1; b >= Math.max(0, i - 14); b--) {
      const hTok = tokens[b];
      if (
        /^(24\s*secondi|Cronometrista|Segnapunti)$/i.test(hTok) ||
        /CONFERMA\.?$/i.test(hTok) ||
        /Arbitro$/i.test(hTok) ||
        /^Squadra/i.test(hTok)
      ) {
        break;
      }

      const mTextDate = hTok.match(
        /^(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})$/i
      );
      if (mTextDate) {
        const dd = mTextDate[1].padStart(2, "0");
        const mm = MONTHS_IT[mTextDate[2].toLowerCase()] || "01";
        dateStr = `${dd}/${mm}/${mTextDate[3]}`;
        continue;
      }

      const mSlashDate = hTok.match(/^(\d{2}\/\d{2}\/\d{4})$/);
      if (mSlashDate) {
        dateStr = mSlashDate[1];
        continue;
      }

      const mTime = hTok.match(/^(\d{2})[:.](\d{2})$/);
      if (mTime) {
        timeStr = `${mTime[1]}:${mTime[2]}`;
        continue;
      }

      if (/^\d{5,6}$/.test(hTok)) {
        matchCode = hTok;
        continue;
      }

      if (/^\d{1,3}$/.test(hTok)) {
        scores.unshift(parseInt(hTok, 10));
      }
    }

    const homeTeam = info.homeTeam.join(" ").trim();
    const awayTeam = info.awayTeam.join(" ").trim();
    if (!homeTeam || !awayTeam) continue;

    const gym = info.gym.join(" ").trim() || `Campo ${homeTeam}`;

    const referees = [];
    const r1 = info.ref1.join(" ").trim();
    const r2 = info.ref2.join(" ").trim();
    if (r1 && !/ATTESA DI CONFERMA/i.test(r1)) referees.push(`1° ${r1}`);
    if (r2 && !/ATTESA DI CONFERMA/i.test(r2)) referees.push(`2° ${r2}`);
    if (referees.length === 0) {
      referees.push("Designazione in attesa di conferma");
    }

    const homeScore = scores.length >= 2 ? scores[scores.length - 2] : null;
    const awayScore = scores.length >= 2 ? scores[scores.length - 1] : null;

    matches.push({
      id: matchCode || `${roundKey}-${homeTeam}-${awayTeam}`,
      matchCode,
      round: roundLabel,
      roundKey,
      date: dateStr,
      dateNum: dateToComparableNum(dateStr),
      time: timeStr,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      played: homeScore !== null && awayScore !== null,
      referees,
      gym,
      isCmb: isCmbTeam(homeTeam) || isCmbTeam(awayTeam),
      isCmbHome: isCmbTeam(homeTeam)
    });
  }

  return matches;
}

function detectArCodes($) {
  let andataCode = "1";
  let ritornoCode = "R";

  // Ispeziona link e opzioni della pagina FIP per rilevare la codifica esatta
  $("a, option").each((_, el) => {
    const text = $(el).text().toLowerCase();
    const href = $(el).attr("href") || $(el).attr("value") || "";
    const m = href.match(/codice_ar=([^&]+)/i);
    if (m) {
      const code = m[1].trim();
      if (/ritorno/i.test(text)) {
        ritornoCode = code;
      } else if (/andata/i.test(text)) {
        andataCode = code;
      }
    }
  });

  return { andataCode, ritornoCode };
}

function buildRoundsList($) {
  const { andataCode, ritornoCode } = detectArCodes($);
  const rounds = [];

  // 11 Giornate di Andata
  for (let g = 1; g <= 11; g++) {
    rounds.push({
      key: `A-${g}`,
      codice_ar: andataCode || "1",
      giornata: g,
      order: 100 + g,
      label: `Giornata ${g} (Andata)`
    });
  }

  // 11 Giornate di Ritorno (codice federale 'R')
  for (let g = 1; g <= 11; g++) {
    rounds.push({
      key: `R-${g}`,
      codice_ar: ritornoCode || "R",
      giornata: g,
      order: 200 + g,
      label: `Giornata ${g} (Ritorno)`
    });
  }

  return rounds;
}

async function fetchRoundMatches(r) {
  let url = `${BASE_FIP_URL}&codice_ar=${r.codice_ar}&giornata=${r.giornata}`;
  let html = await fetchHtml(url);
  let $ = cheerio.load(html);
  let tokens = getTokens($);
  let matches = parseMatches(tokens, r.label, r.key);

  // Fallback automatico se FIP risponde vuoto sul codice Ritorno
  if (matches.length === 0 && r.key.startsWith("R-")) {
    const fallbacks = ["R", "r", "2"].filter((c) => c !== r.codice_ar);
    for (const alt of fallbacks) {
      try {
        const altUrl = `${BASE_FIP_URL}&codice_ar=${alt}&giornata=${r.giornata}`;
        const altHtml = await fetchHtml(altUrl);
        const alt$ = cheerio.load(altHtml);
        const altTokens = getTokens(alt$);
        const altMatches = parseMatches(altTokens, r.label, r.key);
        if (altMatches.length > 0) {
          return altMatches;
        }
      } catch (_) {}
    }
  }

  return matches;
}

function enrichStandingsWithMatches(standings, allMatches) {
  const statsByTeam = {};

  const ensureTeam = (name) => {
    const k = normalizeTeamKey(name);
    if (!statsByTeam[k]) {
      statsByTeam[k] = {
        pf: 0,
        ps: 0,
        playedCount: 0,
        homeWon: 0,
        homeLost: 0,
        awayWon: 0,
        awayLost: 0,
        form: []
      };
    }
    return statsByTeam[k];
  };

  const playedSorted = allMatches
    .filter((m) => m.played && m.homeScore !== null && m.awayScore !== null)
    .sort((a, b) => a.dateNum - b.dateNum);

  for (const m of playedSorted) {
    const hStat = ensureTeam(m.homeTeam);
    const aStat = ensureTeam(m.awayTeam);

    hStat.pf += m.homeScore;
    hStat.ps += m.awayScore;
    hStat.playedCount++;

    aStat.pf += m.awayScore;
    aStat.ps += m.homeScore;
    aStat.playedCount++;

    const homeWin = m.homeScore > m.awayScore;
    if (homeWin) {
      hStat.homeWon++;
      aStat.awayLost++;
    } else {
      hStat.homeLost++;
      aStat.awayWon++;
    }

    hStat.form.push({
      result: homeWin ? "W" : "L",
      score: `${m.homeScore}-${m.awayScore}`,
      opponent: m.awayTeam,
      date: m.date,
      isHome: true
    });

    aStat.form.push({
      result: !homeWin ? "W" : "L",
      score: `${m.awayScore}-${m.homeScore}`,
      opponent: m.homeTeam,
      date: m.date,
      isHome: false
    });
  }

  return standings.map((row) => {
    const k = normalizeTeamKey(row.team);
    const calc = statsByTeam[k] || {
      pf: 0,
      ps: 0,
      playedCount: 0,
      homeWon: 0,
      homeLost: 0,
      awayWon: 0,
      awayLost: 0,
      form: []
    };

    const pf = row.pf > 0 ? row.pf : calc.pf;
    const ps = row.ps > 0 ? row.ps : calc.ps;
    const games = row.played > 0 ? row.played : calc.playedCount;
    const ppg = games > 0 ? Number((pf / games).toFixed(1)) : 0;
    const oppg = games > 0 ? Number((ps / games).toFixed(1)) : 0;

    return {
      ...row,
      pf,
      ps,
      diff: pf - ps,
      ppg,
      oppg,
      homeRecord: `${calc.homeWon}-${calc.homeLost}`,
      awayRecord: `${calc.awayWon}-${calc.awayLost}`,
      last5: calc.form.slice(-5)
    };
  });
}

function getTodayRomeNum() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(new Date())
    .split("-");
  return parseInt(`${parts[0]}${parts[1]}${parts[2]}`, 10);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const forceRefresh = req.query.force === "1";
    const now = Date.now();

    if (!forceRefresh && CACHE.data && now - CACHE.timestamp < 180 * 1000) {
      return res.status(200).json(CACHE.data);
    }

    const initialHtml = await fetchHtml(BASE_FIP_URL);
    const $initial = cheerio.load(initialHtml);
    const rawStandings = parseStandings($initial);
    const availableRounds = buildRoundsList($initial);

    const allMatches = [];
    const seenKeys = new Set();
    const batchSize = 11;

    for (let i = 0; i < availableRounds.length; i += batchSize) {
      const batch = availableRounds.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((r) => fetchRoundMatches(r))
      );

      for (const resItem of results) {
        if (resItem.status === "fulfilled" && Array.isArray(resItem.value)) {
          for (const m of resItem.value) {
            const uniqueId = `${m.roundKey}-${m.homeTeam}-${m.awayTeam}`;
            if (!seenKeys.has(uniqueId)) {
              seenKeys.add(uniqueId);
              allMatches.push(m);
            }
          }
        }
      }
    }

    const standings = enrichStandingsWithMatches(rawStandings, allMatches);
    const todayNum = getTodayRomeNum();

    const cmbMatches = allMatches
      .filter((m) => m.isCmb)
      .sort((a, b) => a.dateNum - b.dateNum);

    const upcomingCmb = cmbMatches.filter(
      (m) => !m.played && m.dateNum >= todayNum
    );

    const nextCmbMatch =
      upcomingCmb[0] ||
      cmbMatches.find((m) => !m.played) ||
      cmbMatches[cmbMatches.length - 1] ||
      null;

    const currentRoundKey = nextCmbMatch
      ? nextCmbMatch.roundKey
      : availableRounds[0]?.key || "A-1";

    const payload = {
      ok: true,
      updatedAt: new Date().toLocaleString("it-IT", {
        timeZone: "Europe/Rome"
      }),
      todayNum,
      currentRoundKey,
      nextCmbMatch,
      upcomingCmbMatches: upcomingCmb.slice(0, 6),
      availableRounds,
      standings,
      matches: allMatches
    };

    CACHE = { timestamp: now, data: payload };
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
