"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";

type Standing = {
  driver: { id: string; name: string; handle: string; avatarUrl?: string | null };
  points: number;
  rank: number | null;
};

type Props = {
  standings: Standing[];
};

const LSR_ORANGE = "#FF8000";

export function ChampionshipChart({ standings }: Props) {
  const top8 = standings
    .filter((s) => s.rank !== null)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 8);

  if (top8.length === 0) {
    return (
      <div className="border border-white/10 bg-black/20 p-8 text-center">
        <p className="font-sans font-bold text-white/40 uppercase tracking-widest text-xs">
          No standings data yet
        </p>
      </div>
    );
  }

  const leaderPoints = top8[0].points;

  const data = top8.map((s) => ({
    name: s.driver.name,
    points: s.points,
    gap: leaderPoints - s.points,
    rank: s.rank,
  }));

  return (
    <div className="border border-white/10 bg-black/20 p-5">
      <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.2em] text-white/40 mb-5">
        Championship Battle
      </h3>
      <ResponsiveContainer width="100%" height={Math.max(200, top8.length * 36)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ left: 0, right: 36, top: 0, bottom: 0 }}
          barSize={16}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
            horizontal={false}
          />
          <XAxis
            type="number"
            domain={[0, leaderPoints]}
            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            tickCount={5}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: "rgba(255,255,255,0.65)", fontSize: 10, fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
            width={90}
            tickFormatter={(name: string) =>
              name.length > 12 ? name.slice(0, 12) + "…" : name
            }
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
            contentStyle={{
              background: "#1B1B1B",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 0,
              fontSize: 11,
              padding: "8px 12px",
            }}
            labelStyle={{ color: "white", fontWeight: 700, marginBottom: 4 }}
            formatter={(value, _name, props: { payload?: { gap: number } }) => {
              const pts = typeof value === "number" ? value : 0;
              const gap = props.payload?.gap ?? 0;
              return [
                <span key="pts" style={{ color: LSR_ORANGE, fontWeight: 700 }}>
                  {pts} pts{gap > 0 ? ` (−${gap})` : ""}
                </span>,
                "",
              ];
            }}
          />
          <Bar dataKey="points" isAnimationActive={false}>
            {data.map((entry, index) => (
              <Cell
                key={entry.id}
                fill={
                  index === 0
                    ? LSR_ORANGE
                    : `rgba(255,128,0,${Math.max(0.15, 0.55 - index * 0.06)})`
                }
              />
            ))}
            <LabelList
              dataKey="points"
              position="right"
              style={{
                fill: "rgba(255,255,255,0.5)",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "monospace",
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
