const cheerio = require("cheerio");

const BASE_FIP_URL =
  "https://fip.it/risultati/?group=campionati-regionali&regione_codice=LO&comitato_codice=PVA&sesso=M&codice_campionato=2DM&codice_fase=1&codice_girone=85812";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "it-IT,it;q=0.9"
};

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
    $(row).find("td").each((__, td) => {
      cols.push($(td).text().replace(/\s+/g, " ").trim());
    });

    if (cols.length >= 4) {
      const firstIsNum = /^\d+$/.test(cols[0]);
      const team = firstIsNum ? cols[1] : cols[0];
      const points = parseInt(firstIsNum ? cols[2] : cols[1], 10);
      const played = parseInt(firstIsNum ? cols[3] : cols[2], 10) || 0;
      const won = parseInt(firstIsNum ? cols[4] : cols[3], 10) || 0;
      const lost = parseInt(firstIsNum ? cols[5] : cols[4], 10) || 0;
      const pf = parseInt(firstIsNum ? cols[6] : cols[5], 10) || 0;
      const ps = parseInt(firstIsNum ? cols[7] : cols[6], 10) || 0;

      if (team && !/^\d+$/.test(team) && !isNaN(points)) {
        standings.push({
          position: firstIsNum ? parseInt(cols[0], 10) : standings.length + 1,
          team,
          points,
          played,
          won,
          lost,
          pf,
          ps
        });
      }
    }
  });
  return standings;
}

function parseMatchesFromPage($) {
  const matches = [];
  let currentRound = "Giornata FIP";

  // Analizza tutte le righe di tutte le tabelle o blocchi gara della pagina FIP
  $("tr, div, li").each((idx, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();

    // Rileva eventuali intestazioni di giornata
    if (/giornata|andata|ritorno/i.test(text) && text.length < 40 && text.length > 3) {
      currentRound = text;
    }

    // Cerca pattern di risultati o incontri (es. Squadra A - Squadra B con punteggio o data)
    const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
    const timeMatch = text.match(/(\d{2}[:.]\d{2})/);
    
    // Identifica se la riga contiene una sfida tra due squadre
    // Cerchiamo elementi con trattino o separatori tipici FIP
    const cells = $(el).find("td");
    if (cells.length >= 3) {
      const cellTexts = [];
      cells.each((_, c) => cellTexts.push($(c).text().replace(/\s+/g, " ").trim()));
      
      // Filtra celle con nomi plausibili di squadre
      const potentialTeams = cellTexts.filter(t => t.length > 3 && !/\d{2}\/\d{2}/.test(t) && !/^\d+$/.test(t));
      if (potentialTeams.length >= 2) {
        const homeTeam = potentialTeams[0];
        const awayTeam = potentialTeams[1];
        
        // Cerca punteggi nelle celle
        let homeScore = null;
        let awayScore = null;
        cellTexts.forEach(txt => {
          const scorePair = txt.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (scorePair) {
            homeScore = parseInt(scorePair[1], 10);
            awayScore = parseInt(scorePair[2], 10);
          }
        });

        const isCmb =
          (homeTeam.toUpperCase().includes("RHO") && (homeTeam.toUpperCase().includes("C.M.B") || homeTeam.toUpperCase().includes("CMB"))) ||
          (awayTeam.toUpperCase().includes("RHO") && (awayTeam.toUpperCase().includes("C.M.B") || awayTeam.toUpperCase().includes("CMB")));

        const matchId = `${homeTeam}-${awayTeam}-${idx}`;
        if (!matches.some(m => m.homeTeam === homeTeam && m.awayTeam === awayTeam)) {
          matches.push({
            id: matchId,
            round: currentRound,
            date: dateMatch ? dateMatch[1] : "Data da definire",
            time: timeMatch ? timeMatch[1].replace(".", ":") : "--:--",
            homeTeam,
            awayTeam,
            homeScore,
            awayScore,
            played: homeScore !== null && awayScore !== null,
            referees: ["Designazione FIP in aggiornamento"],
            gym: `Campo ${homeTeam}`,
            isCmb
          });
        }
      }
    }
  });

  return matches;
}

function parseAvailableRounds($) {
  const rounds = [];
  $("a[href*='giornata='], option[value*='giornata=']").each((_, el) => {
    const href = $(el).attr("href") || $(el).attr("value") || "";
    const label = $(el).text().replace(/\s+/g, " ").trim();
    const arMatch = href.match(/codice_ar=([^&]+)/);
    const gMatch = href.match(/giornata=(\d+)/);
    if (gMatch) {
      const key = `${arMatch ? arMatch[1] : "0"}-${gMatch[1]}`;
      if (!rounds.some((r) => r.key === key)) {
        rounds.push({
          key,
          codice_ar: arMatch ? arMatch[1] : "0",
          giornata: gMatch[1],
          label: label || `Giornata ${gMatch[1]}`
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
    if (giornata) {
      targetUrl += `&codice_ar=${codice_ar || "0"}&giornata=${giornata}`;
    }

    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const standings = parseStandings($);
    const matches = parseMatchesFromPage($);
    const availableRounds = parseAvailableRounds($);

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" }),
      sourceUrl: targetUrl,
      standingsCount: standings.length,
      matchesCount: matches.length,
      availableRounds,
      standings,
      matches
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      sourceUrl: BASE_FIP_URL
    });
  }
};
