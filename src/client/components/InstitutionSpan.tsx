import { useEffect, useMemo } from "react";
import { Data, Institution, InstitutionDictionary, cachedCall, useAppContext } from "client";

interface Props {
  institution_id: string | null;
}

export const InstitutionSpan = ({ institution_id }: Props) => {
  const { data, setData } = useAppContext();
  const { institutions } = data;
  const institution = useMemo(
    () => (institution_id ? institutions.get(institution_id) : undefined),
    [institution_id, institutions],
  );

  useEffect(() => {
    if (!institution_id || institution) return;
    cachedCall<Institution>(`/api/institution?id=${institution_id}`).then((r) => {
      if (!r) return;
      const { body } = r;
      if (!body) return;
      setData((oldData) => {
        const newData = new Data(oldData);
        const institution = new Institution(body);
        const newInstitutions = new InstitutionDictionary(newData.institutions);
        newInstitutions.set(institution_id, institution);
        newData.institutions = newInstitutions;
        return newData;
      });
    });
  }, [setData, institution, institution_id]);

  return <span className="InstitutionSpan">{institution?.name || "Unknown"}</span>;
};
