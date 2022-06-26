import { useEffect } from "react";
import { Institution } from "server";
import { call, useLocalStorage } from "client";

const institutionsCache = new Map<string, Promise<Institution | undefined>>();
const UNKNWON_INSTITUTION = "Unknown Institution";

interface Props {
  institution_id: string;
}

const TagWithValidId = ({ institution_id }: Props) => {
  const [name, setName] = useLocalStorage<string | undefined>(
    `institution_name_${institution_id}`,
    undefined
  );

  useEffect(() => {
    const dynamicCall = async () => {
      const cachedInstitution = institutionsCache.get(institution_id);

      if (cachedInstitution) {
        const institution = await cachedInstitution;
        if (institution) setName(institution.name);
      } else {
        const promisedInstitution = call
          .get<Institution>(`/api/institution?id=${institution_id}`)
          .then((r) => {
            const institution = r.data;
            if (institution) setName(institution.name);
            return institution;
          });

        institutionsCache.set(institution_id, promisedInstitution);
      }
    };

    if (!name) dynamicCall();
  }, [name, setName, institution_id]);

  return <>{name || UNKNWON_INSTITUTION}</>;
};

const InstitutionTag = ({ institution_id }: Partial<Props>) => {
  return (
    <div className="InstitutionTag">
      {institution_id ? (
        <TagWithValidId institution_id={institution_id} />
      ) : (
        UNKNWON_INSTITUTION
      )}
    </div>
  );
};

export default InstitutionTag;
