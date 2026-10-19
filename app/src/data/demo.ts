// The seed content in mock.ts (sample tasks, mail, calendar, "connected" apps,
// memory notes) is for screenshots and design review only: /__seed.html turns
// it on. Real users never see invented data — not while their own data loads,
// and not when a request fails. They see empty states instead.
export const DEMO = (() => {
  try {
    return localStorage.getItem('wingman.demo') === '1'
  } catch {
    return false
  }
})()
