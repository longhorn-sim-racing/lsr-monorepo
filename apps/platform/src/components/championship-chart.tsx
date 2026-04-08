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
import type { PointsProgression } from "@/server/queries/standings";

type Props = {
  progression: PointsProgression;
};

const LSR_ORANGE = "#FF8000";

const LINE_COLORS = [
  LSR_ORANGE,
  "#FF6B35",
  "#E55A2B",
  "#CC4A22",
  "#B33A18",
  "#992B0F",
  "#801C05",
  "#661500",
];

export function ChampionshipChart({ progression }: Props) {
  const { rounds, drivers } = progression;

  if (drivers.length === 0 || rounds.length === 0) {
    return (
      <div className="border border-white/10 bg-black/20 p-8 text-center">
        <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-xs">
          No standings data yet
        </p>
      </div>
    );
  }

  // Transform into recharts-friendly format: one object per round
  const data = rounds.map((round, i) => {
    const point: Record<string, string | number> = { round };
    for (const driver of drivers) {
      point[driver.name] = driver.data[i];
    }
    return point;
  });

  return (
    <div className="border border-white/10 bg-black/20 p-5">
      <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.2em] text-white/40 mb-5">
        Championship Battle
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
          />
          <XAxis
            dataKey="round"
            tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={{
              background: "#1B1B1B",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 0,
              fontSize: 11,
              padding: "8px 12px",
            }}
            labelStyle={{ color: "white", fontWeight: 700, marginBottom: 4 }}
            itemStyle={{ padding: "1px 0" }}
          />
          <Legend
            wrapperStyle={{ fontSize: 9, fontWeight: 700 }}
            iconType="plainline"
            iconSize={12}
          />
          {drivers.map((driver, i) => (
            <Line
              key={driver.name}
              type="monotone"
              dataKey={driver.name}
              stroke={LINE_COLORS[i] || "rgba(255,128,0,0.2)"}
              strokeWidth={i === 0 ? 2.5 : 1.5}
              dot={{ r: 2, fill: LINE_COLORS[i] || "rgba(255,128,0,0.2)" }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
