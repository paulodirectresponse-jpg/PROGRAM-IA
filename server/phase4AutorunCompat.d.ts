export {};

declare global {
  const AuthService: {
    firebaseLogin: (...args: any[]) => { user: { id: string } };
  };
}
