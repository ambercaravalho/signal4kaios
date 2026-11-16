import { useSoftkeys } from '../app/router';
import { QrCode } from '../components/Qr';
import { Screen } from '../components/Screen';

/** A full-screen QR code with a line of explanation under it. */
export function QrScreen(props: { title: string; text?: string; bytes?: Uint8Array; caption?: string }) {
  useSoftkeys({ center: null, right: null });
  return (
    <Screen title={props.title} bodyClass="qr-screen">
      <QrCode text={props.text} bytes={props.bytes} />
      {props.caption && <div class="qr-caption">{props.caption}</div>}
    </Screen>
  );
}
