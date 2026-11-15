import { series, smoothPath, type Point } from "@/lib/chart";
import { Swatch } from "@/components/ui";

const W = 754;
const H = 372;
const PAD = { top: 10, right: 52, bottom: 26, left: 8 };
const Y_MAX = 60000;
const Y_TICKS = [0, 15000, 30000, 45000, 60000];
const X_LABELS = ["Aug 16", "Sep 1", "Sep 15", "Oct 1", "Oct 15", "Nov 1", "Nov 14"];
const CROSS = 71;

const collateral = series(90, 39800, 48230, 900, 7);
const creditLimit = collateral.map((v, i) => v * (0.62 + 0.029 * (i / 89)));
const debt = Array.from({ length: 90 }, (_, i) => (i < 18 ? 9800 : i < 41 ? 11300 : i < 63 ? 12800 : i < 80 ? 13200 : 14500) - (i % 7) * 18);

const lines = [
  { id: "collateral", label: "Collateral", data: collateral, color: "#9e8cff", fill: 0.28, width: 2 },
  { id: "limit", label: "Credit limit", data: creditLimit, color: "#ededef", fill: 0, width: 1.5, dash: "4 4" },
  { id: "debt", label: "Debt", data: debt, color: "#ffa24c", fill: 0.1, width: 1.75 },
];

const iw = W - PAD.left - PAD.right;
const ih = H - PAD.top - PAD.bottom;
const x = (i: number) => PAD.left + (i / 89) * iw;
const y = (v: number) => PAD.top + ih - (v / Y_MAX) * ih;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function PortfolioChart() {
  const cx = x(CROSS);
  return (
    <div className="relative mt-2 h-[372px]">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="text-[11px] [&_text]:fill-t3">
        <defs>
          {lines.map((l) => (
            <linearGradient key={l.id} id={`pf-${l.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={l.color} stopOpacity={l.fill} />
              <stop offset="1" stopColor={l.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {Y_TICKS.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={W - 4} y={y(v) + 4} textAnchor="end">
              {v === 0 ? "$0" : `$${v / 1000}K`}
            </text>
          </g>
        ))}
        {X_LABELS.map((lab, i) => (
          <text key={lab} x={PAD.left + (i / (X_LABELS.length - 1)) * iw} y={H - 6} textAnchor={i === 0 ? "start" : i === X_LABELS.length - 1 ? "end" : "middle"}>
            {lab}
          </text>
        ))}
        {lines.map((l) => {
          const pts: Point[] = l.data.map((v, i) => [x(i), y(v)]);
          const d = smoothPath(pts);
          return (
            <g key={l.id}>
              {l.fill > 0 && <path d={`${d} L${pts[pts.length - 1][0]},${PAD.top + ih} L${pts[0][0]},${PAD.top + ih} Z`} fill={`url(#pf-${l.id})`} />}
              <path d={d} fill="none" stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dash} strokeLinecap="round" />
            </g>
          );
        })}
        <line x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + ih} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
        {lines.map((l) => (
          <g key={l.id}>
            <circle cx={cx} cy={y(l.data[CROSS])} r={7} fill={l.color} fillOpacity={0.18} />
            <circle cx={cx} cy={y(l.data[CROSS])} r={3.5} fill={l.color} stroke="#0d0f12" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      <div className="glass-tip absolute min-w-[170px] rounded-[10px] border border-line-2 px-3 py-2.5 text-xs" style={{ left: cx - 196, top: 18 }}>
        <div className="mb-1.5 text-t3">Oct 26, 2026</div>
        {lines.map((l) => (
          <div key={l.id} className="flex justify-between gap-4 py-0.5">
            <span className="flex items-center gap-1.5 text-t2">
              <Swatch color={l.color} />
              {l.label}
            </span>
            <b className="font-medium">{usd(l.data[CROSS])}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
