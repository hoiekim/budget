import { useSynchronizer } from "lib";

const SyncButton = () => {
  const synchrosize = useSynchronizer()

  return (
    <div className="SyncButton">
      <button onClick={synchrosize}>Sync data</button>
    </div>
  );
};

export default SyncButton;
