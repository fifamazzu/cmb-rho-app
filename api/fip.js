const cheerio = require("cheerio");

// ============================================================================
// CONFIGURAZIONE SQUADRE C.M.B. RHO
// Incolla nei campi "url" i link della pagina risultati FIP di DR2 e U19
// ============================================================================
const TEAMS_CONFIG = {
  DR4: {
    id: "DR4",
    label: "DR4",
    subtitle: "DR4 Girone K",
    url: "https://fip.it/risultati/?group=campionati-regionali&regione_codice=LO&comitato_codice=PVA&sesso=M&codice_campionato=2DM&codice_fase=1&codice_girone=85812"
  },
  DR2: {
    id: "DR2",
    label: "DR2",
    subtitle: "DR2 Lombardia",
    url: "https://fip.it/risultati/?group=campionati-regionali&sesso=M&comitato_codice=RLO&codice_campionato=PM&regione_codice=LO" // <-- Incolla qui il link FIP della DR2
  },
  U19: {
    id: "U19",
    label: "U19",
    subtitle: "Under 19",
    url: "https://fip.it/risultati/?group=campionati-regionali&regione_codice=LO&comitato_codice=PVA&sesso=M&codice_campionato=U19S/M&codice_fase=1&codice_girone=85569" // <-- Incolla qui il link FIP dell'Under 19
  }
};

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

// Cache separata per ogni squadra (durata 2 minuti)
const CACHE = {};

async function fetchHtml(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`FIP.it ha risposto con stato HTTP ${response.status}`);
  }
  return await response.text();
}

function isCmbTeam(name) {
  if (!name) return false;
  const u = name.toUpperCase();
  return (
    u.includes("RHO") &&
    (u.includes("C.M.B") || u.includes("CMB") || u.includes("CENTRO MINI BASKET"))
  );
}

function normalizeKey(str) {
  return (str || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isSameTeam(a, b) {
  if (!a || !b) return false;
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  return ka === kb || ka.includes(kb) || kb.includes(ka);
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
      const team = firstIsNum ? cols[1] : cols[0];
      const points = parseInt(firstIsNum ? cols[2] : cols[1], 10);
      const played = parseInt(firstIsNum ? cols[3] : cols[2], 10) || 0;
      const won = parseInt(firstIsNum ? cols[4] : cols[3], 10) || 0;
      const lost = parseInt(firstIsNum ? cols[5] : cols[4], 10) || 0;
      const pf = parseInt(firstIsNum ? cols[6] : cols[5], 10) || 0;
      const ps = parseInt(firstIsNum ? cols[7] : cols[6], 10) || 0;

      if (
        team &&
        !/^\d+$/.test(team) &&
        !team.includes("Sede:") &&
        !team.includes("Campo da gioco:") &&
        !isNaN(points) &&
        standings.length < 18
      ) {
        standings.push({
          position: firstIsNum ? parseInt(cols[0], 10) : standings.length + 1,
          team,
          points,
          played,
          won,
          lost,
          pf,
          ps,
          diff: pf - ps,
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

function buildFullRoundsList($, teamsCount) {
  const map = new Map();
  let maxRoundFound = teamsCount > 2 ? teamsCount - 1 : 11;

  $("a[href*='giornata='], option[value*='giornata=']").each((_, el) => {
    const href = $(el).attr("href") || $(el).attr("value") || "";
    const arMatch = href.match(/codice_ar=([^&]+)/);
    const gMatch = href.match(/giornata=(\d+)/);
    if (gMatch) {
      const ar = arMatch ? arMatch[1] : "1";
      const g = parseInt(gMatch[1], 10);
      if (g > maxRoundFound) maxRoundFound = g;
      const key = `${ar}-${g}`;
      const fase = ar === "2" || ar.toUpperCase() === "R" ? "Ritorno" : "Andata";
      map.set(key, {
        key,
        codice_ar: ar,
        giornata: g,
        label: `Giornata ${g} (${fase})`
      });
    }
  });

  for (const ar of ["1", "2"]) {
    const fase = ar === "2" ? "Ritorno" : "Andata";
    for (let g = 1; g <= maxRoundFound; g++) {
      const key = `${ar}-${g}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          codice_ar: ar,
          giornata: g,
          label: `Giornata ${g} (${fase})`
        });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.codice_ar !== b.codice_ar) return a.codice_ar.localeCompare(b.codice_ar);
    return a.giornata - b.giornata;
  });
}

function enrichStandingsWithMatches(standings, allMatches) {
  const playedMatches = allMatches
    .filter((m) => m.played && m.homeScore !== null && m.awayScore !== null)
    .sort((a, b) => a.dateNum - b.dateNum);

  return standings.map((row) => {
    let calcPf = 0;
    let calcPs = 0;
    let homeW = 0;
    let homeL = 0;
    let awayW = 0;
    let awayL = 0;
    const history = [];

    for (const m of playedMatches) {
      const isHome = isSameTeam(m.homeTeam, row.team);
      const isAway = isSameTeam(m.awayTeam, row.team);
      if (!isHome && !isAway) continue;

      const myScore = isHome ? m.homeScore : m.awayScore;
      const oppScore = isHome ? m.awayScore : m.homeScore;
      calcPf += myScore;
      calcPs += oppScore;

      const won = myScore > oppScore;
      if (isHome) {
        if (won) homeW++;
        else homeL++;
      } else {
        if (won) awayW++;
        else awayL++;
      }

      history.push({
        result: won ? "W" : "L",
        score: `${m.homeScore}-${m.awayScore}`
      });
    }

    const pf = row.pf > 0 ? row.pf : calcPf;
    const ps = row.ps > 0 ? row.ps : calcPs;

    return {
      ...row,
      pf,
      ps,
      diff: pf - ps,
      homeRecord: `${homeW}-${homeL}`,
      awayRecord: `${awayW}-${awayL}`,
      last5: history.slice(-5)
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
    const requestedTeam = (req.query.team || "DR4").toUpperCase();
    const teamConfig = TEAMS_CONFIG[requestedTeam] || TEAMS_CONFIG.DR4;
    const forceRefresh = req.query.force === "1";
    const now = Date.now();

    const availableTeams = Object.values(TEAMS_CONFIG).map((t) => ({
      id: t.id,
      label: t.label,
      subtitle: t.subtitle,
      configured: Boolean(t.url && t.url.trim())
    }));

    if (!teamConfig.url || !teamConfig.url.trim()) {
      return res.status(200).json({
        ok: false,
        notConfigured: true,
        teamId: teamConfig.id,
        teamSubtitle: teamConfig.subtitle,
        availableTeams,
        error: `Il link FIP per la squadra ${teamConfig.label} non è ancora stato inserito in api/fip.js.`
      });
    }

    const cachedEntry = CACHE[teamConfig.id];
    if (!forceRefresh && cachedEntry && now - cachedEntry.timestamp < 120 * 1000) {
      return res.status(200).json(cachedEntry.data);
    }

    const initialHtml = await fetchHtml(teamConfig.url);
    const $initial = cheerio.load(initialHtml);
    const rawStandings = parseStandings($initial);
    const availableRounds = buildFullRoundsList($initial, rawStandings.length);

    const allMatches = [];
    const seenKeys = new Set();
    const batchSize = 8;

    for (let i = 0; i < availableRounds.length; i += batchSize) {
      const batch = availableRounds.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (r) => {
          const url = `${teamConfig.url}&codice_ar=${r.codice_ar}&giornata=${r.giornata}`;
          const html = await fetchHtml(url);
          const $ = cheerio.load(html);
          const tokens = getTokens($);
          return parseMatches(tokens, r.label, r.key);
        })
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
    const cmbMatches = allMatches.filter((m) => m.isCmb);

    const upcomingCmb = cmbMatches
      .filter((m) => !m.played && m.dateNum >= todayNum)
      .sort((a, b) => a.dateNum - b.dateNum);

    const nextCmbMatch =
      upcomingCmb[0] ||
      cmbMatches.find((m) => !m.played) ||
      cmbMatches[cmbMatches.length - 1] ||
      null;

    const playedCmb = cmbMatches
      .filter((m) => m.played)
      .sort((a, b) => b.dateNum - a.dateNum);
    const lastCmbMatch = playedCmb[0] || null;

    const currentRoundKey = nextCmbMatch
      ? nextCmbMatch.roundKey
      : availableRounds[0]?.key || "1-1";

    const payload = {
      ok: true,
      teamId: teamConfig.id,
      teamLabel: teamConfig.label,
      teamSubtitle: teamConfig.subtitle,
      availableTeams,
      updatedAt: new Date().toLocaleString("it-IT", {
        timeZone: "Europe/Rome"
      }),
      todayNum,
      currentRoundKey,
      nextCmbMatch,
      lastCmbMatch,
      upcomingCmbMatches: upcomingCmb.slice(0, 6),
      availableRounds,
      standings,
      matches: allMatches
    };

    CACHE[teamConfig.id] = { timestamp: now, data: payload };
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
