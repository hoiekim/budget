import { useEffect } from "react";
import { Data, Institution, InstitutionDictionary } from "common";
import { call, useAppContext } from "client";

interface Props {
  institution_id: string;
}

const fetchJobs = new Set<string>();

const InstitutionSpan = ({ institution_id }: Props) => {
  const { data, setData } = useAppContext();
  const { institutions } = data;
  const institution = institutions.get(institution_id);

  useEffect(() => {
    if (!institution_id || institution || fetchJobs.has(institution_id)) return;

    call.get<Institution>(`/api/institution?id=${institution_id}`).then((r) => {
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

    fetchJobs.add(institution_id);
  }, [institutions, setData, institution, institution_id]);

  return <span className="InstitutionSpan">{institution?.name || "Unknown"}</span>;
};

export default InstitutionSpan;
