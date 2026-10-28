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

  // Cerca tutte le righe delle tabelle (la classifica FIP è in una <table>)
  $("table tr").each((_, row) => {
    const cols = [];
    $(row)
      .find("td")
      .each((__, td) => {
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

function parseMatchesFromPage($, roundLabelDefault = "Giornata Corrente") {
  const matches = [];

  // Rileva il nome della giornata attivo nella pagina FIP
  let activeRound =
    $("select[name*='giornata'] option:selected").text().trim() ||
    $(".results-calendar-head, .title-giornata, h3, h4").first().text().trim() ||
    roundLabelDefault;

  // Selettori usati dal portale FIP per ogni singola partita
  const matchContainers = $(
    ".results-matches-item, .results-match, .match-row, .gara, .partita, tr"
  );

  matchContainers.each((idx, el) => {
    const block = $(el);
    const fullText = block.text().replace(/\s+/g, " ").trim();

    // Evita blocchi troppo corti o righe di classifica
    if (fullText.length < 15) return;

    // Cerca nomi squadre nei selettori tipici FIP
    let teams = [];
    block
      .find(
        ".team-name, .results-matches-team, .squadra, .home-team, .away-team, .name"
      )
      .each((_, t) => {
        const name = $(t).text().replace(/\s+/g, " ").trim();
        if (name && name.length > 2 && !/^\d+$/.test(name)) {
          teams.push(name);
        }
      });

    if (teams.length < 2) return;
    const homeTeam = teams[0];
    const awayTeam = teams[1];

    // Punteggi
    let homeScore = null;
    let awayScore = null;
    const scoreNodes = block.find(
      ".score, .results-matches-score, .punteggio, .result, .pts"
    );
    if (scoreNodes.length >= 2) {
      const s1 = parseInt($(scoreNodes[0]).text().replace(/\D/g, ""), 10);
      const s2 = parseInt($(scoreNodes[1]).text().replace(/\D/g, ""), 10);
      if (!isNaN(s1) && !isNaN(s2)) {
        homeScore = s1;
        awayScore = s2;
      }
    } else if (scoreNodes.length === 1) {
      const scoreText = $(scoreNodes[0]).text().trim();
      const m = scoreText.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (m) {
        homeScore = parseInt(m[1], 10);
        awayScore = parseInt(m[2], 10);
      }
    }

    // Data e Ora (es. 25/10/2026 e 21:15)
    const dateMatch = fullText.match(/(\d{2}\/\d{2}\/\d{4})/);
    const timeMatch = fullText.match(/(\d{2}[:.]\d{2})/);
    const date = dateMatch ? dateMatch[1] : "Data da definire";
    const time = timeMatch ? timeMatch[1].replace(".", ":") : "--:--";

    // Estrazione Arbitri dal dettaglio gara FIP
    const referees = [];
    const refRegex =
      /(?:1°\s*Arbitro|2°\s*Arbitro|Arbitr[oi])[:\s]*([A-ZÀ-Ú][A-Za-zÀ-ú\s.'-]+?)(?=\s*(?:1°|2°|Arbitr|Udc|Segnapunti|Cronometrista|Campo|Impianto|Indirizzo|\d{2}\/|$))/gi;
    let refMatch;
    while ((refMatch = refRegex.exec(fullText)) !== null) {
      const cleanRef = refMatch[1].trim();
      if (cleanRef.length > 3 && !referees.includes(cleanRef)) {
        referees.push(cleanRef);
      }
    }

    // Estrazione Campo / Palestra dal dettaglio gara FIP
    let gym = `Campo ${homeTeam}`;
    const gymMatch = fullText.match(
      /(?:Campo(?:\s*di\s*gioco)?|Impianto|Palestra|Indirizzo)[:\s]*([^|•\n]+?)(?=\s*(?:1°|2°|Arbitr|Udc|$))/i
    );
    if (gymMatch && gymMatch[1].trim().length > 4) {
      gym = gymMatch[1].trim();
    }

    const isCmb =
      homeTeam.toUpperCase().includes("RHO") &&
      (homeTeam.toUpperCase().includes("C.M.B") ||
        homeTeam.toUpperCase().includes("CMB")) ||
      (awayTeam.toUpperCase().includes("RHO") &&
        (awayTeam.toUpperCase().includes("C.M.B") ||
          awayTeam.toUpperCase().includes("CMB")));

    matches.push({
      id: `${activeRound}-${idx}`,
      round: activeRound,
      date,
      time,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      played: homeScore !== null && awayScore !== null,
      referees:
        referees.length > 0
          ? referees
          : ["Designazione non ancora pubblicata su FIP"],
      gym,
      isCmb
    });
  });

  return matches;
}

function parseAvailableRounds($) {
  const rounds = [];
  // Cerca i link o le option delle giornate (Andata / Ritorno) presenti nella pagina FIP
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
  // Abilita CORS
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
      updatedAt: new Date().toLocaleString("it-IT", {
        timeZone: "Europe/Rome"
      }),
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
