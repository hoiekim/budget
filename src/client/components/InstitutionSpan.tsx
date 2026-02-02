import { useMemo } from "react";
import { useAppContext } from "client";

interface Props {
  institution_id: string | null;
}

export const InstitutionSpan = ({ institution_id }: Props) => {
  const { data } = useAppContext();
  const { institutions } = data;
  const institution = useMemo(
    () => (institution_id ? institutions.get(institution_id) : undefined),
    [institution_id, institutions],
  );

  return <span className="InstitutionSpan">{institution?.name || "Unknown"}</span>;
};
