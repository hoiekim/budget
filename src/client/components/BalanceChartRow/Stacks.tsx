export interface StackData {
  name: string;
  amount: number;
  color?: string;
}

export type ColumnData = StackData[];

export interface StacksProps {
  data: ColumnData[];
}

export const Stacks = ({ data }: StacksProps) => {
  const totals = data.map((column) => column.reduce((acc, { amount }) => acc + amount, 0));
  const max = Math.max(...totals);

  const columns = data.map((column, i) => {
    const total = totals[i];
    return (
      <div className="column" style={{ height: `${(total / max) * 100}%` }} key={i}>
        {column.map(({ name, amount, color }, j) => (
          <div
            className="stack colored"
            style={{ height: `${(amount / total) * 100}%`, backgroundColor: color }}
            key={j}
          >
            {amount / max > 0.1 && <span>{name}</span>}
          </div>
        ))}
      </div>
    );
  });

  return <div className="Stacks">{columns}</div>;
};
