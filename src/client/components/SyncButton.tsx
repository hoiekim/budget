import { useSync } from "client";

const SyncButton = () => {
  const { sync } = useSync();

  return (
    <div className="SyncButton">
      <button onClick={sync}>Sync data</button>
    </div>
  );
};

export default SyncButton;
