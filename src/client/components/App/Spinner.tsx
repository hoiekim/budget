export const Spinner = () => {
  return (
    <div className="Spinner">
      <div className="svgContainer">
        <svg viewBox="0 0 58 58">
          <circle
            className="arc"
            cx="50%"
            cy="50%"
            r="25"
            fill="none"
            stroke="#bbb"
            strokeWidth="5"
            strokeDasharray="0 157"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="dots">
        <div />
        <div />
        <div />
        <div />
      </div>
    </div>
  );
};
