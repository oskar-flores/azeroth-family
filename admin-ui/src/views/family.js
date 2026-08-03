import { className, raceName } from '../lookups.js';
import { escapeHtml, layout, realmPill, realmLine, dateText } from './layout.js';

export function loginPage({ error, realm } = {}) {
  return layout({
    title: 'Azeroth Familiar',
    lang: 'es',
    body: `
${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
<form action="/login" method="post">
  <label>Usuario <input name="username" autocomplete="username" autocapitalize="none" required></label>
  <label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Entrar</button>
</form>
<p class="muted">Usa el mismo usuario y contraseña del juego.</p>
${realmLine(realm)}`,
  });
}

export function familyPage({ user, realm, realmUp, online, characters, worldMessage }) {
  const characterRows = characters.length === 0
    ? `<tr><td colspan="5" class="muted">Todavía no tienes personajes.</td></tr>`
    : characters.map((c) => `<tr>
        <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td>
        <td>${escapeHtml(className(c.classId))}</td><td>${escapeHtml(raceName(c.raceId))}</td>
        <td>${c.online ? 'sí' : dateText(c.lastPlayed, 'es')}</td></tr>`).join('\n');

  const onlineRows = online.length === 0
    ? `<tr><td colspan="4" class="muted">Nadie conectado ahora mismo.</td></tr>`
    : online.map((c) => `<tr>
        <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td>
        <td>${escapeHtml(className(c.classId))}</td><td>${escapeHtml(raceName(c.raceId))}</td></tr>`).join('\n');

  return layout({
    title: 'Azeroth Familiar',
    lang: 'es',
    user,
    body: `
<p>El reino está ${realmPill(realmUp, 'es')}.</p>
${realmLine(realm)}
${worldMessage ? `<div class="notice">${escapeHtml(worldMessage)}</div>` : ''}

<h2>Quién está jugando</h2>
<table><thead><tr><th>Personaje</th><th>Nivel</th><th>Clase</th><th>Raza</th></tr></thead>
<tbody>${onlineRows}</tbody></table>

<h2>Mis personajes</h2>
<table><thead><tr><th>Personaje</th><th>Nivel</th><th>Clase</th><th>Raza</th><th>Conectado</th></tr></thead>
<tbody>${characterRows}</tbody></table>`,
  });
}
