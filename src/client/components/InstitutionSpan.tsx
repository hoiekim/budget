import { useEffect } from "react";
import { Institution } from "common";
import { call, useAppContext } from "client";

interface Props {
  institution_id: string;
}

const fetchJobs = new Map<string | undefined, Promise<Institution | undefined>>();

const InstitutionSpan = ({ institution_id }: Props) => {
  const { institutions, setInstitutions } = useAppContext();
  const institution = institutions.get(institution_id);

  useEffect(() => {
    if (!institution_id || institution || fetchJobs.has(institution_id)) return;

    const promisedInstitution = call
      .get<Institution>(`/api/institution?id=${institution_id}`)
      .then((r) => {
        const institution = r.data;

        if (institution) {
          setInstitutions((oldInstitutions) => {
            const newInstitutions = new Map(oldInstitutions);
            newInstitutions.set(institution_id, institution);
            return newInstitutions;
          });
        }

        return institution;
      });

    fetchJobs.set(institution_id, promisedInstitution);
  }, [institutions, setInstitutions, institution, institution_id]);

  return <span className="InstitutionSpan">{institution?.name || "Unknown"}</span>;
};

export default InstitutionSpan;
