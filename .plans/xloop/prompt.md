# PREPARE ENVIRONMENT

## Install dependencies

`npm install`

# PRD
Read the attached PRD tasks list.

# TASK SELECTION

Pick the next single task that's not completed yet. Prioritize from this list (where 1 is highest priority):

1. Dependencies
1. Architectural decisions and core abstractions
2. Integration points between modules
3. Unknown unknowns and spike work
4. Standard features
5. Polish and quick wins

If there are no tasks left with `completed: false`, exit with `<promise>COMPLETE</promise>`

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

# EXECUTION

Complete the single task.

If you find that the task is larger than you expected (for instance, requires a refactor first), output "HANG ON A SECOND".

Then, find a way to break it into a smaller chunk and only do that chunk (i.e. complete the smaller refactor).

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- `npm run test` to run the unit tests, if setup
- `npm run tsc` to run the type checker
- `npm run build` to run the build
- If CLI or script, run them and verify output.

# PROGRESS

## PROGRESS
After completing, append to progress.txt:

- Task completed and PRD reference
- Key decisions made
- Files changed
- Blockers or notes for next iteration
  Keep entries concise.
- Ensure you commit progress.txt with the changed code

## MARK COMPLETION
After completed, update task list file by updating `completed: true` on that task.

## UPDATE LEARNINGS
Update `AGENTS.md` with any learnings and patterns that would be useful for future agents. This file is not for documentation, just learnings and caveats for future programmers. Be terse and don't use for documentation, because it will get stale.

# FINISH

## GIT COMMIT

You must make a git commit with a clear message.

## PRINT IN TERMINAL

If the task is complete, print "Task #<nr> complete"

# FINAL RULES

- ONLY WORK ON A SINGLE TASK. THEN STOP.
- If there are no tasks left with `completed: false`, exit with `<promise>COMPLETE</promise>`
- Add unit tests where it makes sense.
- Always commit to git on completion.
