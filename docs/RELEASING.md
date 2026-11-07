# Releasing SoundControl (signed releases)

Installs update themselves with one click (Help → Updating → *Update now*), but
**only to release tags signed with a trusted release key**. This page is for
maintainers.

## How trust works

- `release/allowed_signers` lists the public release key(s). It ships inside
  every release.
- An install reads that file **from the version it is running** when it
  starts, and only accepts a new tag whose SSH signature matches it
  (`git verify-tag`). A tag pushed by someone without the private key, or an
  unsigned tag, is refused; so is a tag that does not continue from the
  installed version (fast-forward only).
- To rotate the key, add the new public key to `release/allowed_signers`,
  release once signed with the **old** key (so installs learn the new one),
  then sign later releases with the new key and remove the old line.

## One-time setup (maintainer machine)

```bash
ssh-keygen -t ed25519 -C "SoundControl release signing" -f ~/.ssh/soundcontrol_release_ed25519
printf 'release@soundcontrol %s\n' "$(cut -d' ' -f1,2 ~/.ssh/soundcontrol_release_ed25519.pub)" >> release/allowed_signers
git config gpg.format ssh
git config user.signingkey ~/.ssh/soundcontrol_release_ed25519.pub
git config tag.gpgSign true
git config gpg.ssh.allowedSignersFile "$PWD/release/allowed_signers"
```

Optional: add the public key to GitHub as a **signing key** (Settings → SSH and
GPG keys → New SSH key → Key type *Signing Key*) so tags show *Verified*.

Keep the private key off shared machines and out of the repository.

## Cutting a release

1. Bump `version` in `package.json` and add a `## [X.Y.Z] - date` section at the
   top of `CHANGELOG.md` (installs show it as "What's new").
2. `npm test` and `npm audit` must be clean.
3. Commit, then create the **signed** tag and check it:
   ```bash
   git tag -s vX.Y.Z -m "SoundControl vX.Y.Z"
   git verify-tag vX.Y.Z        # must say: Good "git" signature for release@soundcontrol
   git push origin main vX.Y.Z
   ```
Installs notice the new tag within a few hours and offer *Update now*.
