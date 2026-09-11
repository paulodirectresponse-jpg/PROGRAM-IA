import config from '../../firebase-applet-config.json' with { type: 'json' };

/** Identity is obtained from Firebase, never from client-supplied email/uid. */
export async function verifyFirebaseIdentity(idToken: unknown) {
  if (typeof idToken !== 'string' || idToken.length < 32 || idToken.length > 20000) {
    throw new Error('Token de autenticação Firebase obrigatório.');
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY || config.apiKey;
  if (!apiKey) throw new Error('Firebase do aplicativo não configurado no servidor.');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Sessão Firebase inválida ou expirada. Entre novamente.');
  const body = await response.json();
  const user = body.users?.[0];
  if (!user?.localId || !user?.email || user.disabled) throw new Error('Identidade Firebase não autorizada.');
  return { uid: String(user.localId), email: String(user.email), name: String(user.displayName || '') };
}
