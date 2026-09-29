"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export type LapPositionData = {
  lap: number;
  [driverName: string]: number;
};

type Props = {
  data: LapPositionData[];
  drivers: string[];
  driverCount: number;
};

function formatLapTime(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

type TooltipEntry = {
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: Record<string, number>;
};

function LapTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const entries = payload
    .filter(
      (p) =>
        typeof p.dataKey === "string" &&
        !p.dataKey.endsWith("__lapTime") &&
        p.value !== undefined
    )
    .map((p) => ({
      name: p.dataKey as string,
      position: p.value as number,
      color: p.color,
      lapTime: p.payload?.[`${p.dataKey as string}__lapTime`],
    }))
    .sort((a, b) => a.position - b.position);

  return (
    <div
      style={{
        background: "#1B1B1B",
        border: "1px solid rgba(255,255,255,0.1)",
        padding: "8px 12px",
        fontSize: 11,
      }}
    >
      <div style={{ color: "white", fontWeight: 700, marginBottom: 6 }}>
        Lap {label}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "2px 10px" }}>
        {entries.map((e) => (
          <div key={e.name} style={{ display: "contents", color: e.color }}>
            <span style={{ fontWeight: 700 }}>P{e.position}</span>
            <span>{e.name}</span>
            <span style={{ fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.8)" }}>
              {formatLapTime(e.lapTime)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LINE_COLORS = [
  "#FF8000",
  "#FF6B35",
  "#E55A2B",
  "#CC4A22",
  "#B33A18",
  "#992B0F",
  "#801C05",
  "#661500",
  "#4D9BFF",
  "#3DDC84",
  "#E040FB",
  "#FFEB3B",
  "#00BCD4",
  "#FF5252",
  "#7C4DFF",
  "#64FFDA",
];

export function LapPositionChart({ data, drivers, driverCount }: Props) {
  if (data.length === 0 || drivers.length === 0) {
    return null;
  }

  return (
    <div className="border border-white/10 bg-black/20 p-5 mt-4">
      <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.2em] text-white/40 mb-5">
        Lap-by-Lap Positions
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
          />
          <XAxis
            dataKey="lap"
            tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
            label={{
              value: "Lap",
              position: "insideBottomRight",
              offset: -5,
              style: { fill: "rgba(255,255,255,0.25)", fontSize: 9, fontWeight: 700 },
            }}
          />
          <YAxis
            reversed
            domain={[1, driverCount]}
            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={32}
            allowDecimals={false}
            label={{
              value: "Position",
              angle: -90,
              position: "insideLeft",
              offset: 10,
              style: { fill: "rgba(255,255,255,0.25)", fontSize: 9, fontWeight: 700 },
            }}
          />
          <Tooltip content={<LapTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 9, fontWeight: 700 }}
            iconType="plainline"
            iconSize={12}
          />
          {drivers.map((driver, i) => (
            <Line
              key={driver}
              type="monotone"
              dataKey={driver}
              stroke={LINE_COLORS[i % LINE_COLORS.length]}
              strokeWidth={i === 0 ? 2.5 : 1.5}
              dot={{ r: 2, fill: LINE_COLORS[i % LINE_COLORS.length] }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
