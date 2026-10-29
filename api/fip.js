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
  { key: "stop", regex: /^(Segnapunti|Cronometrista|24\s*secondi)$/i }
];

async function fetchHtml(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`FIP.it ha risposto con stato HTTP ${response.status}`);
  }
  return await response.text();
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
          lost
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

function parseMatches(tokens, activeRoundLabel) {
  const matches = [];
  let prevMatchEnd = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (!/^Squadra di casa$/i.test(tokens[i])) continue;

    // 1. Estrae i campi del pannello Info (Squadra di casa, ospite, Campo, Arbitri)
    const info = {
      homeTeam: [],
      awayTeam: [],
      gym: [],
      ref1: [],
      ref2: [],
      ref3: []
    };

    let currentKey = "homeTeam";
    let k = i + 1;
    for (; k < Math.min(tokens.length, i + 40); k++) {
      const tok = tokens[k];
      if (/^Squadra di casa$/i.test(tok)) break;
      const lbl = matchLabel(tok);
      if (lbl) {
        if (lbl === "stop") {
          currentKey = null;
        } else {
          currentKey = lbl;
        }
        if (/^24\s*secondi$/i.test(tok)) {
          k++;
          break;
        }
        continue;
      }
      if (currentKey && info[currentKey]) {
        info[currentKey].push(tok);
      }
    }

    // 2. Cerca data, ora, codice gara e punteggio nei token subito prima di "Squadra di casa"
    const headerSlice = tokens.slice(Math.max(prevMatchEnd, i - 16), i);
    prevMatchEnd = k;

    let dateStr = "Data da definire";
    let timeStr = "--:--";
    const scores = [];

    for (const hTok of headerSlice) {
      // Data formato "29 Ottobre 2026"
      const mTextDate = hTok.match(
        /^(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})$/i
      );
      if (mTextDate) {
        const dd = mTextDate[1].padStart(2, "0");
        const mm = MONTHS_IT[mTextDate[2].toLowerCase()] || "01";
        dateStr = `${dd}/${mm}/${mTextDate[3]}`;
        continue;
      }

      // Data formato "29/10/2026"
      const mSlashDate = hTok.match(/^(\d{2}\/\d{2}\/\d{4})$/);
      if (mSlashDate) {
        dateStr = mSlashDate[1];
        continue;
      }

      // Orario formato "21:15"
      const mTime = hTok.match(/^(\d{2})[:.](\d{2})$/);
      if (mTime) {
        timeStr = `${mTime[1]}:${mTime[2]}`;
        continue;
      }

      // Punteggi (numeri di 1-3 cifre che non sono il codice gara a 5-6 cifre)
      if (/^\d{1,3}$/.test(hTok)) {
        scores.push(parseInt(hTok, 10));
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

    const isCmb =
      homeTeam.toUpperCase().includes("RHO") &&
      (homeTeam.toUpperCase().includes("C.M.B") ||
        homeTeam.toUpperCase().includes("CMB")) ||
      (awayTeam.toUpperCase().includes("RHO") &&
        (awayTeam.toUpperCase().includes("C.M.B") ||
          awayTeam.toUpperCase().includes("CMB")));

    matches.push({
      id: `${homeTeam}-${awayTeam}-${i}`,
      round: activeRoundLabel,
      date: dateStr,
      time: timeStr,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      played: homeScore !== null && awayScore !== null,
      referees,
      gym,
      isCmb
    });
  }

  return matches;
}

function parseAvailableRounds($) {
  const rounds = [];
  $("a[href*='giornata='], option[value*='giornata=']").each((_, el) => {
    const href = $(el).attr("href") || $(el).attr("value") || "";
    const rawLabel = $(el).text().replace(/\s+/g, " ").trim();
    const arMatch = href.match(/codice_ar=([^&]+)/);
    const gMatch = href.match(/giornata=(\d+)/);
    if (gMatch) {
      const ar = arMatch ? arMatch[1] : "0";
      const g = gMatch[1];
      const key = `${ar}-${g}`;
      if (!rounds.some((r) => r.key === key)) {
        const gironeFase = ar === "1" || ar === "R" ? "Ritorno" : "Andata";
        rounds.push({
          key,
          codice_ar: ar,
          giornata: g,
          label: /^\d+$/.test(rawLabel)
            ? `Giornata ${g} (${gironeFase})`
            : rawLabel || `Giornata ${g}`
        });
      }
    }
  });
  return rounds;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const { codice_ar, giornata } = req.query;
    let targetUrl = BASE_FIP_URL;
    let roundLabel = "Giornata Corrente";

    if (giornata) {
      const ar = codice_ar || "0";
      targetUrl += `&codice_ar=${ar}&giornata=${giornata}`;
      const fase = ar === "1" || ar === "R" ? "Ritorno" : "Andata";
      roundLabel = `Giornata ${giornata} (${fase})`;
    }

    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);
    const tokens = getTokens($);

    const standings = parseStandings($);
    const matches = parseMatches(tokens, roundLabel);
    const availableRounds = parseAvailableRounds($);

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toLocaleString("it-IT", {
        timeZone: "Europe/Rome"
      }),
      sourceUrl: targetUrl,
      standings,
      matches,
      availableRounds
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
// FINE FILE COMPLETO
