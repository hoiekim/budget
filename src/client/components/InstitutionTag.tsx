import { useEffect } from "react";
import { call, useLocalStorage } from "client";
import { Institution } from "server";

interface Props {
  institution_id: string | undefined;
}

const UNKNWON_INSTITUTION = "Unknown Institution";

const TagWithValidId = ({ institution_id }: Props) => {
  const [institution, setInstitution] = useLocalStorage<
    Institution | undefined
  >(`institution_${institution_id}`, undefined);

  useEffect(() => {
    if (!institution) {
      call<Institution>(`/api/institution?id=${institution_id}`).then((r) => {
        setInstitution(r.data);
      });
    }
  }, [institution, setInstitution]);

  return <>{institution?.name || UNKNWON_INSTITUTION}</>;
};

const InstitutionTag = ({ institution_id }: Props) => {
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
