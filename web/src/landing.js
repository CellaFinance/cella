// Landing page motion. One idea: scrolling walks you through the gate.
// The arch grows until its ivory door fills the screen, and the next section
// is the ivory room behind it.
const gate = document.getElementById("gate");
const stage = document.getElementById("stage");
const arch = document.getElementById("arch");
const hero = document.getElementById("heroText");
const cue = document.getElementById("cue");
const nav = document.querySelector(".nav");
const walls = [document.getElementById("wallOuter"), document.getElementById("wallInner")];
const still = matchMedia("(prefers-reduced-motion: reduce)");

const clamp = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => t * t * (3 - 2 * t);
let maxScale = 30;

function measure() {
  // The door is 12% of the arch wide and 46% tall, with a rounded top.
  const size = arch.offsetWidth;
  const doorW = size * 0.12, doorH = size * 0.46;
  const reach = Math.max(innerWidth / doorW, innerHeight / (doorH - doorW / 2));
  maxScale = reach * 2.4;
}

function frame() {
  ticking = false;
  if (still.matches) return;
  const r = gate.getBoundingClientRect();
  const p = clamp(-r.top / (r.height - innerHeight));

  hero.style.opacity = String(1 - clamp(p / 0.2));
  hero.style.transform = `translateY(${-40 * clamp(p / 0.2)}px)`;
  hero.style.pointerEvents = p > 0.15 ? "none" : "";
  cue.style.opacity = String(1 - clamp(p / 0.08));
  // The menu is ivory; it leaves before the ivory door reaches it.
  nav.style.opacity = String(1 - clamp((p - 0.3) / 0.15));
  nav.style.pointerEvents = p > 0.4 ? "none" : "";

  const t = ease(clamp((p - 0.1) / 0.86));
  arch.style.transform = `scale(${Math.pow(maxScale, t)})`;
  const wallOpacity = String(1 - clamp((t - 0.3) / 0.3));
  for (const w of walls) w.style.opacity = wallOpacity;
  stage.style.background = t > 0.995 ? "var(--ivory)" : "";
}

let ticking = false;
function onScroll() {
  if (!ticking) { ticking = true; requestAnimationFrame(frame); }
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", () => { measure(); onScroll(); });
measure();
frame();

const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); seen.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px" });
for (const el of document.querySelectorAll(".reveal")) seen.observe(el);

// The status section says where this copy of the site points: a test network or mainnet.
fetch("/deployment.json", { cache: "no-store" }).then((r) => r.json()).then((d) => {
  if (d.dev || d.testKey) return;
  const rows = [
    ["Circuit", "Written and tested", false],
    ["Contracts", `Live on ${d.chainName}. Limits: ${d.maxDeposit ?? "0.1"} ETH per deposit, ${d.poolCap ?? "5"} ETH in total`, false],
    ["Web app, relayer, auditor tool", "Live", false],
    ["Proving key", "Public Hermez ceremony, then one contribution and a chain beacon. More contributors welcome", false],
    ["Independent audit", "Not done yet", true],
  ];
  document.getElementById("statusLede").textContent = `Cella is live on ${d.chainName} as a limited beta. No outside firm has audited it yet, so deposits are capped. Use only amounts you could afford to lose.`;
  document.getElementById("statusSteps").replaceChildren(...rows.map(([k, v, todo]) => {
    const row = Object.assign(document.createElement("div"), { className: "in" + (todo ? " todo" : "") });
    row.append(Object.assign(document.createElement("span"), { textContent: k }), Object.assign(document.createElement("span"), { textContent: v }));
    return row;
  }));
}).catch(() => {});
