// TalkShop payment configuration endpoint.
// Demo mode is active when STRIPE_SECRET_KEY is absent: the checkout page
// then uses a fully local simulated card flow (no real charges).
// Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in Vercel env to go live.
module.exports = (req, res) => {
  const secret = process.env.STRIPE_SECRET_KEY || "";
  const demo = !secret;
  res.status(200).json({
    demo: demo,
    publishableKey: demo ? null : (process.env.STRIPE_PUBLISHABLE_KEY || null)
  });
};
