import { useCallback, useEffect, useState } from "react";
import { call, PATH, useAppContext } from "client";
import { GetHoldingSnapshotsResponse, HoldingSnapshotWithSecurity } from "server";
import "./index.css";

interface Props {
  accountId: string;
}

export const HoldingsManager = ({ accountId }: Props) => {
  const { router } = useAppContext();

  const [snapshots, setSnapshots] = useState<HoldingSnapshotWithSecurity[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchSnapshots = useCallback(async () => {
    setIsLoading(true);
    const r = await call
      .get<GetHoldingSnapshotsResponse>(`/api/snapshots/holding?account_id=${accountId}`)
      .catch(console.error);
    if (r?.status === "success" && r.body) {
      setSnapshots(r.body.snapshots);
    }
    setIsLoading(false);
  }, [accountId]);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  const goToHolding = (snapshotId?: string) => {
    const params = new URLSearchParams();
    params.set("account_id", accountId);
    if (snapshotId) params.set("snapshot_id", snapshotId);
    router.go(PATH.HOLDING_DETAIL, { params });
  };

  const renderHoldings = () => {
    if (isLoading) {
      return (
        <div className="row">
          <span className="propertyName">Loading…</span>
        </div>
      );
    }
    if (snapshots.length === 0) {
      return (
        <div className="row">
          <span className="propertyName disabled">No holdings recorded</span>
        </div>
      );
    }
    return snapshots.map((s) => {
      const ticker = s.ticker_symbol || s.holding_security_id.slice(0, 8);
      const qty = s.quantity != null ? `${s.quantity} sh` : "—";
      const detail = [
        s.cost_basis != null ? `$${s.cost_basis.toFixed(2)}/sh` : null,
        s.snapshot_date?.slice(0, 10) ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        <div
          key={s.snapshot_id}
          className="row keyValue holdingRow"
          role="button"
          tabIndex={0}
          onClick={() => goToHolding(s.snapshot_id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              goToHolding(s.snapshot_id);
            }
          }}
        >
          <span className="propertyName" title={s.security_name || undefined}>
            {ticker}
          </span>
          <span className="holdingDetail">
            <span>{qty}</span>
            {detail && <span className="small">{detail}</span>}
          </span>
        </div>
      );
    });
  };

  return (
    <>
      <div className="propertyLabel">Holdings</div>
      <div className="property">
        {renderHoldings()}
        <div className="row button">
          <button type="button" onClick={() => goToHolding()}>
            Add&nbsp;Holding
          </button>
        </div>
      </div>
    </>
  );
};
