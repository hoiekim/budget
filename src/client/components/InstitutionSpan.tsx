import { useEffect } from "react";
import { Institution } from "common";
import { call, useAppContext } from "client";

interface Props {
  institution_id: string;
}

const fetchJobs = new Set<string>();

const InstitutionSpan = ({ institution_id }: Props) => {
  const { institutions, setInstitutions } = useAppContext();
  const institution = institutions.get(institution_id);

  useEffect(() => {
    if (!institution_id || institution || fetchJobs.has(institution_id)) return;

    call.get<Institution>(`/api/institution?id=${institution_id}`).then((r) => {
      const { data } = r;
      if (!data) return;
      setInstitutions((oldInstitutions) => {
        const institution = new Institution(data);
        const newInstitutions = new Map(oldInstitutions);
        newInstitutions.set(institution_id, institution);
        return newInstitutions;
      });
    });

    fetchJobs.add(institution_id);
  }, [institutions, setInstitutions, institution, institution_id]);

  return <span className="InstitutionSpan">{institution?.name || "Unknown"}</span>;
};

export default InstitutionSpan;
