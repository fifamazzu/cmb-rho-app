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

  // Cerca blocchi specifici di partite o righe tabella
  $("tr, .match-row, .results-match, .gara-item").each((idx, el) => {
    const block = $(el);
    const text = block.text().replace(/\s+/g, " ").trim();

    // Rileva intestazione giornata
    if (/giornata|andata|ritorno/i.test(text) && text.length < 40 && text.length > 3) {
      currentRound = text;
    }

    // Estrai celle
    const cells = block.find("td");
    if (cells.length >= 2) {
      const cellTexts = [];
      cells.each((_, c) => {
        const cText = $(c).text().replace(/\s+/g, " ").trim();
        if (cText) cellTexts.push(cText);
      });

      // Cerca squadre nelle celle (escludendo stringhe di servizio o codici)
      const validTexts = cellTexts.filter(t => 
        t.length > 3 && 
        !t.includes("Sede:") && 
        !t.includes("Riferimento:") && 
        !t.includes("Studio GBO") &&
        !/^\d{5,}/.test(t)
      );

      if (validTexts.length >= 2) {
        // Tenta di identificare casa e ospite
        let homeTeam = validTexts[0];
        let awayTeam = validTexts[1];

        // Punteggi
        let homeScore = null;
        let awayScore = null;
        cellTexts.forEach(txt => {
          const scorePair = txt.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (scorePair) {
            homeScore = parseInt(scorePair[1], 10);
            awayScore = parseInt(scorePair[2], 10);
          }
        });

        // Data e ora pulite
        const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
        const timeMatch = text.match(/(\d{2}[:.]\d{2})/);

        // Estrazione pulita del campo (cercando parole chiave senzadumpare l'intera anagrafica)
        let gym = `Palestra di ${homeTeam}`;
        const gymMatch = text.match(/(?:Campo\s*da\s*gioco|Impianto|Palestra)[:\s]*([^•\n]+?)(?=\s*(?:Riferimento|Sede|1°|2°|$))/i);
        if (gymMatch && gymMatch[1].trim().length > 4) {
          gym = gymMatch[1].trim().replace(/00\d+\s*/g, ""); // Pulisce eventuali codici residui
        }

        const isCmb =
          (homeTeam.toUpperCase().includes("RHO") && (homeTeam.toUpperCase().includes("C.M.B") || homeTeam.toUpperCase().includes("CMB"))) ||
          (awayTeam.toUpperCase().includes("RHO") && (awayTeam.toUpperCase().includes("C.M.B") || awayTeam.toUpperCase().includes("CMB")));

        if (homeTeam && awayTeam && !matches.some(m => m.homeTeam === homeTeam && m.awayTeam === awayTeam)) {
          matches.push({
            id: `${homeTeam}-${awayTeam}-${idx}`,
            round: currentRound,
            date: dateMatch ? dateMatch[1] : "Data da definire",
            time: timeMatch ? timeMatch[1].replace(".", ":") : "--:--",
            homeTeam,
            awayTeam,
            homeScore,
            awayScore,
            played: homeScore !== null && awayScore !== null,
            referees: ["Designazione in attesa di conferma"],
            gym,
            isCmb
          });
        }
      }
    }
  });

  return matches;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const html = await fetchHtml(BASE_FIP_URL);
    const $ = cheerio.load(html);

    const standings = parseStandings($);
    const matches = parseMatchesFromPage($);

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" }),
      standings,
      matches
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
