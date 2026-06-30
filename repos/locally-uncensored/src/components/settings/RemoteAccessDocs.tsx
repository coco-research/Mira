import {
  Smartphone, Wifi, Globe, QrCode, KeyRound, Shield, Server, Plug,
} from 'lucide-react'

// §16 (F5/X2 follow-up) — Static "How it works" docs for Remote Access.
//
// Pure presentational: no hooks, no fetches, no store reads. Lives inside a
// collapsible block next to RemoteAccessSettings in the Voice & Remote tab.
// Copy is kept accurate to the actual feature (remoteStore + Sidebar dispatch
// flow + the Rust axum server on port 11435) — it does not promise anything
// the app can't do. Styling mirrors the surrounding settings panels
// (text-[0.55rem]/[0.65rem], gray scale, lucide icons at size 12).

function Step({ n, icon, title, children }: {
  n: number
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 mt-0.5 w-4 h-4 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-[0.55rem] font-semibold text-gray-600 dark:text-gray-400">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[0.65rem] font-medium text-gray-700 dark:text-gray-300">{title}</span>
        </div>
        <div className="mt-0.5 text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  )
}

export function RemoteAccessDocs() {
  return (
    <div className="space-y-3">
      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        Remote Access lets you continue a chat from your phone (or any device on
        the same network, or over the internet) while the model keeps running on
        this machine. Nothing leaves your computer except the chat with your
        paired device — generation still happens locally.
      </p>

      <div className="space-y-2.5">
        <Step n={1} icon={<Plug size={12} className="text-gray-500" />} title="Open the Remote tab">
          In the sidebar, switch to the <span className="text-gray-400 font-medium">Remote</span> tab
          (next to Chat and Code). This is where you start a remote session and see its status.
        </Step>

        <Step n={2} icon={<Wifi size={12} className="text-gray-500" />} title="Dispatch over LAN">
          Click <span className="text-gray-400 font-medium">Dispatch → LAN</span>, pick the chat to
          share and a working folder, and LU starts a local server on this machine. Your phone
          reaches it directly over your home/office Wi-Fi — fastest, and the traffic never leaves
          your network. Both devices must be on the same network.
        </Step>

        <Step n={3} icon={<Globe size={12} className="text-gray-500" />} title="Dispatch over the internet">
          Choose <span className="text-gray-400 font-medium">Dispatch → Internet</span> instead to
          reach LU from anywhere. LU starts a Cloudflare tunnel and gives you a public
          <span className="text-gray-400"> https://…trycloudflare.com</span> URL — no router or
          port-forwarding setup. The tunnel only exists while the session is dispatched.
        </Step>

        <Step n={4} icon={<QrCode size={12} className="text-gray-500" />} title="Scan the QR or enter the passcode">
          After dispatch, the Remote tab shows a QR code and a short numeric passcode. On your
          phone, scan the QR to open the mobile chat page, then type the
          <KeyRound size={9} className="inline mx-0.5 -mt-0.5 text-gray-500" />
          <span className="text-gray-400 font-medium">passcode</span> to pair. The passcode rotates
          for security; use <span className="text-gray-400 font-medium">Restart</span> in the Remote
          tab to keep the same chat but issue a fresh one.
        </Step>

        <Step n={5} icon={<Server size={12} className="text-gray-500" />} title="Endpoint & disconnecting">
          The local server listens on <span className="text-gray-400 font-mono">port 11435</span>.
          Paired devices appear under <span className="text-gray-400 font-medium">Connected Devices</span> in
          Settings → Voice &amp; Remote → Remote Access — hit the trash icon next to a device to kick
          it. Ending the dispatch (Undispatch) stops the server and the tunnel.
        </Step>
      </div>

      {/* Permission scopes */}
      <div className="pt-2 border-t border-gray-200 dark:border-white/[0.06] space-y-2">
        <div className="flex items-center gap-1.5">
          <Shield size={12} className="text-gray-500" />
          <span className="text-[0.65rem] font-medium text-gray-400">What a paired device may do</span>
        </div>
        <p className="text-[0.55rem] text-gray-500 leading-relaxed">
          Three permission switches (in the Remote Access panel above) gate what a remote device can
          trigger on this machine. All are off until you turn them on:
        </p>
        <ul className="space-y-1.5">
          <li>
            <p className="text-[0.6rem] text-gray-700 dark:text-gray-300">Filesystem Access</p>
            <p className="text-[0.55rem] text-gray-500">
              Lets the remote agent read and write files and run shell commands in the dispatched
              working folder. Leave off if you only want to chat.
            </p>
          </li>
          <li>
            <p className="text-[0.6rem] text-gray-700 dark:text-gray-300">Downloads &amp; Installs</p>
            <p className="text-[0.55rem] text-gray-500">
              Allows the remote device to start model downloads and ComfyUI / Ollama installs on this
              machine.
            </p>
          </li>
          <li>
            <p className="text-[0.6rem] text-gray-700 dark:text-gray-300">Process Control</p>
            <p className="text-[0.55rem] text-gray-500">
              Allows starting and stopping local backends (ComfyUI, Ollama) from the remote device.
            </p>
          </li>
        </ul>
      </div>

      <div className="flex items-start gap-1.5 pt-1 text-[0.55rem] text-gray-500 dark:text-gray-600">
        <Smartphone size={11} className="shrink-0 mt-0.5" />
        <span>
          Tip: pair only devices you trust, and turn off permissions you don't need — a paired phone
          acts with whatever scopes are enabled here.
        </span>
      </div>
    </div>
  )
}
