import { Fragment, useState } from "react";
import { DEMO_USERNAME } from "common";
import {
  ButtonRow,
  DeleteButton,
  KeyValue,
  Property,
  PropertyLabel,
  Row,
  useAppContext,
  useSharing,
} from "client";

const alertFailure = (message?: string) => {
  if (message) window.alert(message);
};

export const SharingSection = () => {
  const { user, data } = useAppContext();
  const { members, invitations } = data.sharing ?? { members: [], invitations: [] };
  const { invite, accept, dismiss, remove } = useSharing();

  const [username, setUsername] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [inviteError, setInviteError] = useState<string>();

  if (!user || user.username === DEMO_USERNAME) return null;

  const others = members.filter((member) => member.user_id !== user.user_id);
  const received = invitations.filter(({ invitee }) => invitee.user_id === user.user_id);
  const sent = invitations.filter(({ invitee }) => invitee.user_id !== user.user_id);

  const onClickAccept = (invitation_id: string, inviter: string) => {
    const question =
      `Share data with ${inviter}? You will see and edit each other's accounts, ` +
      `transactions and budgets, and so will anyone ${inviter} already shares with.`;
    if (window.confirm(question)) accept(invitation_id).then(alertFailure);
  };

  const onClickInvite = async () => {
    setIsSending(true);
    const failure = await invite(username.trim());
    setIsSending(false);
    setInviteError(failure);
    if (!failure) setUsername("");
  };

  return (
    <>
      {others.map((member, i) => (
        <Fragment key={member.user_id}>
          <PropertyLabel>Sharing&nbsp;With{others.length > 1 && <>&nbsp;{i + 1}</>}</PropertyLabel>
          <Property>
            <KeyValue name="User">
              <span>{member.username}</span>
            </KeyValue>
            <Row className="button">
              <DeleteButton
                confirmMessage={`Stop sharing data with ${member.username}? Each of you keeps the data you own.`}
                onClick={() => remove(member.user_id).then(alertFailure)}
              >
                Stop&nbsp;Sharing
              </DeleteButton>
            </Row>
          </Property>
        </Fragment>
      ))}
      {others.length > 1 && (
        <>
          <PropertyLabel>&nbsp;</PropertyLabel>
          <Property>
            <Row className="button">
              <DeleteButton
                confirmMessage="Stop sharing data with everyone? You keep the data you own."
                onClick={() => remove(user.user_id).then(alertFailure)}
              >
                Stop&nbsp;Sharing&nbsp;With&nbsp;Everyone
              </DeleteButton>
            </Row>
          </Property>
        </>
      )}
      {received.map(({ invitation_id, inviter }) => (
        <Fragment key={invitation_id}>
          <PropertyLabel>Invitation&nbsp;To&nbsp;Share</PropertyLabel>
          <Property>
            <KeyValue name="From">
              <span>{inviter.username}</span>
            </KeyValue>
            <ButtonRow type="button" onClick={() => onClickAccept(invitation_id, inviter.username)}>
              Accept
            </ButtonRow>
            <ButtonRow type="button" onClick={() => dismiss(invitation_id).then(alertFailure)}>
              Decline
            </ButtonRow>
          </Property>
        </Fragment>
      ))}
      {sent.map(({ invitation_id, inviter, invitee }) => (
        <Fragment key={invitation_id}>
          <PropertyLabel>Sent&nbsp;Invitation</PropertyLabel>
          <Property>
            <KeyValue name="To">
              <span>{invitee.username}</span>
            </KeyValue>
            {inviter.user_id !== user.user_id && (
              <KeyValue name="From">
                <span>{inviter.username}</span>
              </KeyValue>
            )}
            <ButtonRow type="button" onClick={() => dismiss(invitation_id).then(alertFailure)}>
              Withdraw
            </ButtonRow>
          </Property>
        </Fragment>
      ))}
      <PropertyLabel>Share&nbsp;Data</PropertyLabel>
      <Property>
        <Row>
          <span className="propertyName disabled">
            Whoever accepts sees and edits everything here, and you everything of theirs.
          </span>
        </Row>
        <KeyValue name="Username">
          <input
            type="text"
            aria-label="Username to share data with"
            placeholder="Their username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isSending}
            maxLength={255}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </KeyValue>
        {inviteError && (
          <Row>
            <span className="propertyName disabled">{inviteError}</span>
          </Row>
        )}
        <ButtonRow type="button" onClick={onClickInvite} disabled={isSending || !username.trim()}>
          Send&nbsp;Invitation
        </ButtonRow>
      </Property>
    </>
  );
};
