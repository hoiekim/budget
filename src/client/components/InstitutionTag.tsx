import { useEffect } from "react";
import { Institution } from "server";
import { call, useAppContext } from "client";

const UNKNWON_INSTITUTION = "Unknown Institution";

interface Props {
  institution_id?: string;
}

const fetchJobs = new Map<string | undefined, Promise<Institution | undefined>>();

const InstitutionTag = ({ institution_id }: Partial<Props>) => {
  const { institutions, setInstitutions } = useAppContext();
  const institution = institutions.get(institution_id);

  useEffect(() => {
    const dynamicCall = async () => {
      if (fetchJobs.has(institution_id)) return;

      const promisedInstitution = call
        .get<Institution>(`/api/institution?id=${institution_id}`)
        .then((r) => {
          const institution = r.data;

          if (institution) {
            const newInstitutions = new Map(institutions);
            newInstitutions.set(institution_id, institution);
            setInstitutions(newInstitutions);
          }

          return institution;
        });

      fetchJobs.set(institution_id, promisedInstitution);
    };

    if (institution_id && !institution) dynamicCall();
  }, [institutions, setInstitutions, institution, institution_id]);

  return <div className="InstitutionTag">{institution?.name || UNKNWON_INSTITUTION}</div>;
};

export default InstitutionTag;
