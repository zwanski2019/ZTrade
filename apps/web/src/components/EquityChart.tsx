import { useMemo, useState } from "react";
import type { EquityPoint } from "@ztrade/shared";
import { dateTime, signedUsd, usd } from "../lib/format";

/**
 * Dependency-free equity curve.
 *
 * A charting library would be ~100kB for one line and a hover readout; this is
 * a plain SVG path with a hit-testing overlay, and it scales with the
 * container via viewBox.
 */
export function EquityChart({
  points,
  height = 220,
  className = "",
}: {
  points: EquityPoint[];
  height?: number;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const WIDTH = 800;
  const PAD = { top: 12, right: 12, bottom: 12, left: 12 };

  const geometry = useMemo(() => {
    if (points.length < 2) return null;

    const values = points.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Flat curves would divide by zero; give them a nominal band.
    const span = max - min || Math.abs(max) || 1;

    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;

    const coords = points.map((p, i) => ({
      x: PAD.left + (i / (points.length - 1)) * innerW,
      y: PAD.top + innerH - ((p.equity - min) / span) * innerH,
    }));

    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
    const area =
      `${line} L${coords.at(-1)!.x},${height - PAD.bottom} ` +
      `L${coords[0]!.x},${height - PAD.bottom} Z`;

    return { coords, line, area, min, max };
  }, [points, height]);

  if (!geometry) {
    return (
      <div
        className={`flex items-center justify-center font-mono text-xs text-outline ${className}`}
        style={{ height }}
      >
        Not enough data to plot yet
      </div>
    );
  }

  const first = points[0]!.equity;
  const lastPoint = points.at(-1)!;
  const gaining = lastPoint.equity >= first;
  const stroke = gaining ? "#00FF41" : "#ffb4ab";
  const active = hover !== null ? points[hover] : null;

  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label="Cumulative equity curve"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={geometry.area} fill="url(#equityFill)" />
        <path
          d={geometry.line}
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null && geometry.coords[hover] && (
          <>
            <line
              x1={geometry.coords[hover]!.x}
              y1={PAD.top}
              x2={geometry.coords[hover]!.x}
              y2={height - PAD.bottom}
              stroke="#84967e"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={geometry.coords[hover]!.x}
              cy={geometry.coords[hover]!.y}
              r="3"
              fill={stroke}
            />
          </>
        )}
      </svg>

      {active && (
        <div className="pointer-events-none absolute left-3 top-2 border border-outline-variant bg-surface-container-lowest px-2.5 py-1.5 font-mono text-[10px]">
          <div className="text-outline">{dateTime(active.at)}</div>
          <div className="text-on-surface">Equity: {usd(active.equity)}</div>
          <div className={active.pnl >= 0 ? "text-primary" : "text-error"}>
            P&amp;L: {signedUsd(active.pnl)}
          </div>
        </div>
      )}
    </div>
  );
}
