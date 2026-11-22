import { Fragment, useState } from "react";
import { DEMO_USERNAME, getLocaleDateString } from "common";
import type { SharingInvitation } from "server";
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

/** The username it went to, or the email address it was sent to. */
const inviteeName = ({ invitee }: SharingInvitation): string =>
  "email" in invitee ? invitee.email : invitee.username;

const hasLapsed = ({ expires_at }: SharingInvitation, now: number): boolean =>
  expires_at !== undefined && Date.parse(expires_at) <= now;

export const SharingSection = () => {
  const { user, data } = useAppContext();
  const { members, invitations } = data.sharing ?? { members: [], invitations: [] };
  const { invite, accept, dismiss, remove } = useSharing();

  const [target, setTarget] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [inviteError, setInviteError] = useState<string>();

  if (!user || user.username === DEMO_USERNAME) return null;

  const others = members.filter((member) => member.user_id !== user.user_id);
  const isReceived = ({ invitee }: SharingInvitation) =>
    "user_id" in invitee && invitee.user_id === user.user_id;
  const received = invitations.filter(isReceived);
  const sent = invitations.filter((invitation) => !isReceived(invitation));
  const now = Date.now();

  const onClickAccept = (invitation_id: string, inviter: string) => {
    const question =
      `Share data with ${inviter}? You will see and edit each other's accounts, ` +
      `transactions and budgets, and so will anyone ${inviter} already shares with.`;
    if (window.confirm(question)) accept(invitation_id).then(alertFailure);
  };

  const onClickInvite = async () => {
    setIsSending(true);
    const failure = await invite(target.trim());
    setIsSending(false);
    setInviteError(failure);
    if (!failure) setTarget("");
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
      {sent.map((invitation) => {
        const { invitation_id, inviter, invitee, expires_at } = invitation;
        const lapsed = hasLapsed(invitation, now);
        return (
          <Fragment key={invitation_id}>
            <PropertyLabel>Sent&nbsp;Invitation</PropertyLabel>
            <Property>
              <KeyValue name="To">
                <span>{inviteeName(invitation)}</span>
              </KeyValue>
              {inviter.user_id !== user.user_id && (
                <KeyValue name="From">
                  <span>{inviter.username}</span>
                </KeyValue>
              )}
              {expires_at && (
                <KeyValue name={lapsed ? "Expired" : "Expires"}>
                  <span>{getLocaleDateString(new Date(expires_at))}</span>
                </KeyValue>
              )}
              {/* Sending again renews the sender's own invitation, so it is theirs to send. */}
              {lapsed && "email" in invitee && inviter.user_id === user.user_id && (
                <ButtonRow type="button" onClick={() => invite(invitee.email).then(alertFailure)}>
                  Send&nbsp;Again
                </ButtonRow>
              )}
              <ButtonRow type="button" onClick={() => dismiss(invitation_id).then(alertFailure)}>
                Withdraw
              </ButtonRow>
            </Property>
          </Fragment>
        );
      })}
      <PropertyLabel>Share&nbsp;Data</PropertyLabel>
      <Property>
        <Row>
          <span className="propertyName disabled">
            Whoever accepts sees and edits everything here, and you everything of theirs.
          </span>
        </Row>
        <Row>
          <span className="propertyName disabled">
            An invitation sent to an email address reaches whoever signs in with it in the next 30
            days, even if they have no account yet.
          </span>
        </Row>
        <KeyValue name="User">
          <input
            type="text"
            aria-label="Username or email address to share data with"
            placeholder="Their username or email"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
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
        <ButtonRow type="button" onClick={onClickInvite} disabled={isSending || !target.trim()}>
          Send&nbsp;Invitation
        </ButtonRow>
      </Property>
    </>
  );
};
