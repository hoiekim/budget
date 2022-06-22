import { useSynchronizer } from "client";

const SyncButton = () => {
  const { sync } = useSynchronizer();

  return (
    <div className="SyncButton">
      <button onClick={sync}>Sync data</button>
    </div>
  );
};

export default SyncButton;
