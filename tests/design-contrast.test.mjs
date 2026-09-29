// Contrasto WCAG 2.1 della palette "Fumé" di src/styles.css, in tutti e due i temi di Windows.
// I token vengono letti dal foglio di stile (e la tinta di Acrylic da main.rs): se un colore cambia li', il test
// lo ricontrolla al giro successivo.
//
// Il vetro e' traslucido: sotto il velo CSS (--glass-*) c'e' il materiale di Windows, e sotto ancora il desktop.
// Ogni coppia viene misurata sul caso peggiore, con il materiale sopra un desktop nero e sopra uno bianco:
// - mica: il materiale di Windows 11, modellato come la sua tinta (scuro #202020 all'80 %, chiaro #F3F3F3 al 50 %)
//   sopra lo sfondo. Il Mica vero ha anche uno strato di luminosita' che lo rende piu' uniforme: il modello e'
//   pessimista.
// - acrylic: la tinta che main.rs passa ad Acrylic su Windows 10 (ACRYLIC_TINT_*) sopra cio' che sta dietro la
//   finestra, anche finestre piene di testo; Windows 11 usa l'Acrylic di sistema, piu' denso di questa tinta.
// - none: nessun materiale, il velo --glass-solid direttamente sopra il desktop.
// Testo: almeno 4,5:1 (tutto il testo dell'interfaccia e' sotto i 18 px). Grafica, anelli di fuoco e stati dei
// controlli: almeno 3:1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const mainRs = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

function declarations(block) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const lightBlock = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n {2}\}/.exec(css)?.[1];
assert.ok(lightBlock, "styles.css: blocco :root del tema chiaro non trovato");
assert.ok(darkBlock, "styles.css: blocco :root del tema scuro non trovato");

const THEMES = {
  light: declarations(lightBlock),
  dark: { ...declarations(lightBlock), ...declarations(darkBlock) }
};

function acrylicTint(name) {
  const match = new RegExp(`const ${name}: \\(u8, u8, u8, u8\\) = \\((\\d+), (\\d+), (\\d+), (\\d+)\\);`).exec(mainRs);
  assert.ok(match, `main.rs: ${name} non trovato`);
  const [r, g, b, a] = match.slice(1).map(Number);
  return [r, g, b, a / 255];
}

const MATERIALS = {
  mica: { glass: "--glass-mica", light: [243, 243, 243, 0.5], dark: [32, 32, 32, 0.8] },
  acrylic: { glass: "--glass-acrylic", light: acrylicTint("ACRYLIC_TINT_LIGHT"), dark: acrylicTint("ACRYLIC_TINT_DARK") },
  none: { glass: "--glass-solid", light: null, dark: null }
};

const DESKTOPS = [[0, 0, 0, 1], [255, 255, 255, 1]];

function parse(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/i.exec(value);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
  throw new Error(`non e' un colore: ${value}`);
}

function over([r, g, b, a], [R, G, B]) {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

function luminance(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const GRAPHIC = 3;

// [colore in primo piano, strati sopra il velo dal basso verso l'alto, minimo, dove si vede]
const PAIRS = [
  ["--ink", [], TEXT, "testo cercato, titoli delle righe"],
  ["--ink-2", [], TEXT, "marchio e suggerimenti nella barra delle azioni"],
  ["--ink-3", [], TEXT, "segnaposto, percorsi, suggerimenti, nota legale"],
  ["--ink", ["--sel-fill"], TEXT, "titolo della riga selezionata"],
  ["--ink-2", ["--sel-fill"], TEXT, "azione della riga selezionata"],
  ["--ink-3", ["--sel-fill"], TEXT, "percorso della riga selezionata"],
  ["--ink-2", ["--badge"], TEXT, "etichetta del tipo, RAM"],
  ["--ink-2", ["--sel-fill", "--badge"], TEXT, "etichetta del tipo nella riga selezionata"],
  ["--ink-2", ["--ctl"], TEXT, "tasti"],
  ["--ink-2", ["--sel-fill", "--ctl"], TEXT, "tasto Invio nella riga selezionata"],
  ["--ink", ["--ctl"], TEXT, "filtri"],
  ["--ink", ["--accent-soft"], TEXT, "filtri selezionati con Ctrl+A"],
  ["--warning", ["--ctl"], TEXT, "filtro della modalita' privata"],
  ["--ink", ["--card"], TEXT, "etichette delle impostazioni"],
  ["--ink-3", ["--card"], TEXT, "descrizioni delle impostazioni"],
  ["--ink", ["--card", "--ctl"], TEXT, "pulsanti"],
  ["--ink", ["--card", "--ctl-hover"], TEXT, "pulsanti al passaggio"],
  ["--danger", ["--card"], TEXT, "Svuota recenti, errori"],
  ["--danger", ["--card", "--danger-soft"], TEXT, "Svuota recenti al passaggio"],
  ["--ok", ["--card"], TEXT, "esiti riusciti"],
  ["--on-accent", ["--card", "--accent-fill"], TEXT, "Scarica la versione …"],
  ["--ink-2", ["--card", "--popover"], TEXT, "scelte rapide"],
  ["--ink-3", ["--card", "--popover"], TEXT, "scelte rapide non disponibili"],
  ["--ink", ["--card", "--popover", "--ctl-hover"], TEXT, "scelta rapida evidenziata"],
  ["--on-accent", ["--accent"], GRAPHIC, "simbolo del tasto Invio"],
  ["--accent", [], GRAPHIC, "anello di fuoco, cursore del testo"],
  ["--accent", ["--card"], GRAPHIC, "interruttore acceso, anello nelle impostazioni"],
  ["--sw-off-edge", ["--card"], GRAPHIC, "interruttore spento"]
];

for (const [theme, tokens] of Object.entries(THEMES)) {
  const colour = (name) => {
    assert.ok(tokens[name], `styles.css (${theme}): manca ${name}`);
    return parse(tokens[name]);
  };
  for (const [material, model] of Object.entries(MATERIALS)) {
    const backgrounds = (stack) => DESKTOPS.map((desk) => {
      const behind = model[theme] ? over(model[theme], desk) : desk;
      return stack.reduce((below, layer) => over(colour(layer), below), over(colour(model.glass), behind));
    });
    for (const [fg, stack, min, where] of PAIRS) {
      const label = `${theme}, ${material}: ${fg} on ${[model.glass, ...stack].join(" + ")}`;
      test(`${label} >= ${min}:1 (${where})`, () => {
        const worst = Math.min(...backgrounds(stack).map((bg) => ratio(over(colour(fg), bg), bg)));
        if (process.env.PRINT_CONTRAST) console.log(`| ${label} | ${worst.toFixed(2)} | ${min} |`);
        assert.ok(worst >= min, `${label}: ${worst.toFixed(2)}:1`);
      });
    }
  }
}
