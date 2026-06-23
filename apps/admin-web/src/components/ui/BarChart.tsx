import "./BarChart.css";

export type BarChartDatum = {
  label: string;
  value: number;
  color: string;
};

export function BarChart({ data, height = 180 }: { data: BarChartDatum[]; height?: number }) {
  const maxValue = Math.max(1, ...data.map((item) => item.value));

  return (
    <div className="bar-chart" style={{ height }}>
      {data.map((item) => (
        <div className="bar-chart-col" key={item.label} title={`${item.label}: ${item.value}`}>
          <span className="bar-chart-value">{item.value}</span>
          <div className="bar-chart-track">
            <div
              className="bar-chart-bar"
              style={{
                height: `${item.value === 0 ? 0 : Math.max(4, (item.value / maxValue) * 100)}%`,
                background: item.color,
              }}
            />
          </div>
          <span className="bar-chart-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
