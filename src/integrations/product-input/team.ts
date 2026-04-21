export const TEAM: Record<
  string,
  { githubLogin: string; displayName: string }
> = {
  U0AMQ6VEKQE: {
    githubLogin: 'david-gonzalez-pnw',
    displayName: 'David Gonzalez',
  },
  U0ANLGKAD96: { githubLogin: 'parsa7', displayName: 'Parsa Pezeshki' },
  U0AMVRJLVE0: { githubLogin: 'a7medkamel', displayName: 'Ahmed Kamel' },
};

export function githubLoginForSlackUser(userId: string): string | undefined {
  return TEAM[userId]?.githubLogin;
}

export function isTeamMember(userId: string): boolean {
  return userId in TEAM;
}

export const GITHUB_REPO = '<owner>/<repo>';
export const SLACK_PI_CHANNEL = 'C0AU1BM8ZGD';
