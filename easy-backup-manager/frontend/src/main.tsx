import React from 'react';
import ReactDOM from 'react-dom/client';
import { Activity, AlertTriangle, Database, HardDrive, PlayCircle, Server } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './styles.css';

const stats = [
  { label: 'Total de PCs', value: '40', icon: Server, tone: 'text-sky-300' },
  { label: 'Online', value: '38', icon: Activity, tone: 'text-emerald-300' },
  { label: 'Backup OK', value: '35', icon: Database, tone: 'text-teal-300' },
  { label: 'Falhas', value: '5', icon: AlertTriangle, tone: 'text-rose-300' },
  { label: 'Espaco usado', value: '18 TB', icon: HardDrive, tone: 'text-indigo-300' },
];

const machines = [
  { name: 'CLINICA-PC-01', ip: '10.10.12.31', os: 'Windows 11 Pro', status: 'online', backup: 'OK', last: 'Hoje 12:20', group: 'Clinica' },
  { name: 'FINANCEIRO-02', ip: '10.10.12.48', os: 'Windows 10 Pro', status: 'online', backup: 'Running', last: 'Em andamento', group: 'Financeiro' },
  { name: 'RECEPCAO-04', ip: '10.10.12.77', os: 'Windows 11 Pro', status: 'offline', backup: 'Failed', last: 'Ontem 22:14', group: 'Recepcao' },
];

const chart = [
  { day: 'Seg', tb: 13 },
  { day: 'Ter', tb: 14.5 },
  { day: 'Qua', tb: 15.2 },
  { day: 'Qui', tb: 16.9 },
  { day: 'Sex', tb: 18 },
];

function App() {
  return (
    <main className="min-h-screen bg-ink text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6 px-6 py-6">
        <aside className="hidden w-64 shrink-0 rounded-lg border border-line bg-panel p-5 lg:block">
          <div className="text-sm uppercase tracking-wide text-sky-300">EASY</div>
          <div className="mt-1 text-2xl font-bold">Backup Manager</div>
          <nav className="mt-8 space-y-2 text-sm text-slate-300">
            {['Dashboard', 'Maquinas', 'Backups', 'Alertas', 'Storage', 'UrBackup'].map((item) => (
              <button key={item} className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-800">{item}</button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Dashboard de backups</h1>
              <p className="mt-1 text-sm text-slate-400">UrBackup engine, painel corporativo e automacao propria.</p>
            </div>
            <button className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-4 py-2 font-semibold text-white hover:bg-sky-400">
              <PlayCircle size={18} /> Iniciar backup
            </button>
          </header>

          <div className="mt-6 grid gap-4 md:grid-cols-5">
            {stats.map(({ label, value, icon: Icon, tone }) => (
              <div key={label} className="rounded-lg border border-line bg-panel p-4">
                <div className={`mb-4 ${tone}`}><Icon size={22} /></div>
                <div className="text-2xl font-bold">{value}</div>
                <div className="text-sm text-slate-400">{label}</div>
              </div>
            ))}
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_360px]">
            <section className="rounded-lg border border-line bg-panel p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Maquinas protegidas</h2>
                <span className="text-sm text-slate-400">40 endpoints</span>
              </div>
              <div className="overflow-hidden rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr><th className="p-3">Nome</th><th>IP</th><th>Sistema</th><th>Status</th><th>Backup</th><th>Ultimo</th><th>Grupo</th></tr>
                  </thead>
                  <tbody>
                    {machines.map((m) => (
                      <tr key={m.name} className="border-t border-line">
                        <td className="p-3 font-medium">{m.name}</td><td>{m.ip}</td><td>{m.os}</td>
                        <td><span className={m.status === 'online' ? 'text-emerald-300' : 'text-rose-300'}>{m.status}</span></td>
                        <td>{m.backup}</td><td>{m.last}</td><td>{m.group}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="rounded-lg border border-line bg-panel p-5">
              <h2 className="text-lg font-semibold">Uso de storage</h2>
              <div className="mt-4 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chart}>
                    <XAxis dataKey="day" stroke="#94a3b8" />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip />
                    <Area dataKey="tb" type="monotone" stroke="#38bdf8" fill="#0ea5e9" fillOpacity={0.24} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 rounded-md bg-slate-900 p-3 text-sm text-slate-300">
                Falhas recentes: RECEPCAO-04 perdeu janela de backup. FINANCEIRO-02 esta com job em andamento.
              </div>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
