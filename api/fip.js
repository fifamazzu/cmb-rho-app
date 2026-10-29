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
  gennaio: 0,
  febbraio: 1,
  marzo: 2,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  agosto: 7,
  settembre: 8,
  ottobre: 9,
  novembre: 10,
  dicembre: 11
};

const INFO_LABELS = [
  { key: "homeTeam", regex: /^Squadra di casa$/i },
  { key: "awayTeam", regex: /^Squadra ospite$/i },
  { key: "gym", regex: /^Campo di gioco$/i },
  { key: "ref1", regex: /^1\s*[^\w\s]?\s*Arbitro$/i },
  { key: "ref2", regex: /^2\s*[^\w\s]?\s*Arbitro$/i },
  { key: "ref3", regex: /^3\s*[^\w\s]?\s*Arbitro$/i },
  { key: "scorer", regex: /^Segnapunti$/i },
  { key: "timer", regex: /^Cronometrista$/i },
  { key: "shotclock", regex: /^24\s*secondi$/i }
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

      // Ignora tabelle anagrafiche (es. Sede, Studio GBO, codici FIP a 6 cifre)
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

function getTextTokens($, rootNode) {
  const tokens = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "text") {
      const t = $(node).text().replace(/\s+/g, " ").trim();
      if (t) tokens.push(t);
    } else if (
      node.type === "tag" &&
      node
