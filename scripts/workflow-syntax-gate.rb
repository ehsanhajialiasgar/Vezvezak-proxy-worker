# WORKFLOW SYNTAX GATE (2026-09-11) — run by .git/hooks/pre-commit.
#
# I broke this repo's only workflow TWICE IN TWO DAYS, both times by pushing text that was never
# parsed by anything until GitHub tried to run it:
#   2026-09-10  an unterminated quote inside a `run:` block — the job printed its own success line
#               and then died at exit 2. Red for a syntax error, in the very step built to stop red
#               from pointing at the wrong thing.
#   2026-09-11  a heredoc whose body sat at column 0, which closes the YAML block scalar. The whole
#               workflow stopped parsing, so the run had ZERO jobs and `gh run view` showed no
#               failing step to read — a failure with nothing to read is worse than a loud one.
#
# Neither was caught by review, and neither could be: they are not visible by reading. The unit is
# the PARSER, not the eye. Two checks, because a workflow has two languages in one file:
#   1. the YAML must parse;
#   2. every `run:` block must parse as SHELL — GitHub validates the YAML and never the shell.
require 'yaml'
require 'tmpdir'

fails = []
Dir.glob('.github/workflows/*.{yml,yaml}').sort.each do |f|
  doc = begin
    YAML.load_file(f)
  rescue => e
    fails << "#{f}: YAML does not parse — #{e.message.lines.first.to_s.strip}"
    next
  end
  (doc['jobs'] || {}).each do |jn, job|
    (job['steps'] || []).each_with_index do |st, i|
      next unless st['run']
      Dir.mktmpdir do |d|
        p = File.join(d, 'step.sh')
        File.write(p, st['run'])
        unless system("bash -n #{p} 2>#{d}/err")
          err = File.read("#{d}/err").lines.first.to_s.strip.sub(%r{\A\S*step\.sh: }, '')
          fails << "#{f}: job '#{jn}' step #{i} (#{st['name'] || 'unnamed'}) — shell does not parse: #{err}"
        end
      end
    end
  end
end

if fails.empty?
  n = Dir.glob('.github/workflows/*.{yml,yaml}').size
  puts "  OK - #{n} workflow file(s): YAML parses and every run: block parses as shell"
  exit 0
end
warn 'X WORKFLOW SYNTAX:'
fails.each { |x| warn "    #{x}" }
warn '  GitHub validates the YAML and NEVER the shell inside it. A run: block with broken shell'
warn '  reaches the runner and dies mid-step, after printing whatever came before the error.'
exit 1
