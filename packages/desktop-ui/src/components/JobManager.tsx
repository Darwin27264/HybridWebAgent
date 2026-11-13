import React, { useState } from 'react';
import {
  Calendar,
  Clock,
  Play,
  Square,
  Trash2,
  Plus,
  Edit2,
  Check,
  X,
  ExternalLink,
  RotateCw,
  Layers,
  AlertCircle,
  Eye,
} from 'lucide-react';
import type { Job, CompiledTaskSpec } from '@ofln-scout/shared';
import { useScoutStore } from '../store/useScoutStore';
import { wsClient } from '../lib/wsClient';
import { toast } from 'sonner';

export const JobManager: React.FC = () => {
  const jobs = useScoutStore((state) => state.jobs);
  const activeJobId = useScoutStore((state) => state.activeJobId);
  const setActiveJobId = useScoutStore((state) => state.setActiveJobId);
  const setSpec = useScoutStore((state) => state.setSpec);
  const setActiveTab = useScoutStore((state) => state.setActiveTab);
  const currentSpec = useScoutStore((state) => state.currentSpec);
  const isLaunching = useScoutStore((state) => state.isLaunching);
  const isStopping = useScoutStore((state) => state.isStopping);

  const [isCreating, setIsCreating] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);

  // Form state for creation
  const [newJobName, setNewJobName] = useState('');
  const [newJobCron, setNewJobCron] = useState('*/5 * * * *');
  const [newJobIsScheduled, setNewJobIsScheduled] = useState(false);
  const [newJobTargetUrl, setNewJobTargetUrl] = useState('');
  const [newJobGoal, setNewJobGoal] = useState('');

  // Form state for editing
  const [editJobName, setEditJobName] = useState('');
  const [editJobCron, setEditJobCron] = useState('');
  const [editJobIsScheduled, setEditJobIsScheduled] = useState(false);

  const handleStartCreate = () => {
    setNewJobName(currentSpec ? `${currentSpec.name} Job` : 'New Periodic Scout');
    setNewJobTargetUrl(currentSpec?.targetUrl || 'https://news.ycombinator.com');
    setNewJobGoal(currentSpec?.userGoal || 'Monitor page for updates');
    setNewJobCron('*/5 * * * *');
    setNewJobIsScheduled(false);
    setIsCreating(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newJobName.trim()) {
      toast.error('Job name is required');
      return;
    }

    const baseSpec: CompiledTaskSpec = currentSpec
      ? {
          ...currentSpec,
          id: `task-${Date.now()}`,
          name: newJobName.trim(),
          targetUrl: newJobTargetUrl.trim() || currentSpec.targetUrl,
          userGoal: newJobGoal.trim() || currentSpec.userGoal,
          createdAt: Date.now(),
        }
      : {
          id: `task-${Date.now()}`,
          name: newJobName.trim(),
          userGoal: newJobGoal.trim() || 'Monitor target site',
          targetUrl: newJobTargetUrl.trim() || 'https://example.com',
          domSelector: 'article, .post, .item',
          pollIntervalMs: 600,
          scrollStepPx: 350,
          questions: {
            is_relevant: {
              type: 'noul',
              statement: 'This content contains a relevant announcement or update.',
            },
          },
          alertRule: {
            questionKey: 'is_relevant',
            operator: 'boolean_true',
            targetValue: true,
            minAnswerConfidence: 0.8,
          },
          createdAt: Date.now(),
        };

    const ok = wsClient.createJob(
      newJobName.trim(),
      baseSpec,
      newJobCron.trim() || undefined,
      newJobIsScheduled
    );

    if (ok) {
      toast.success(`Job "${newJobName}" created successfully`);
      setIsCreating(false);
    } else {
      toast.error('Failed to send create job request to daemon');
    }
  };

  const handleStartEdit = (job: Job) => {
    setEditingJobId(job.id);
    setEditJobName(job.name);
    setEditJobCron(job.cronSchedule || '*/5 * * * *');
    setEditJobIsScheduled(job.isScheduled);
  };

  const handleSaveEdit = (jobId: string) => {
    const ok = wsClient.updateJob(
      jobId,
      editJobName.trim(),
      undefined,
      editJobCron.trim() || undefined,
      editJobIsScheduled
    );
    if (ok) {
      toast.success('Job schedule updated');
      setEditingJobId(null);
    }
  };

  const handleDelete = (jobId: string, name: string) => {
    if (window.confirm(`Are you sure you want to delete job "${name}"?`)) {
      wsClient.deleteJob(jobId);
    }
  };

  const handleTriggerRun = (job: Job) => {
    setActiveJobId(job.id);
    setSpec(job.spec);
    wsClient.startJob(job.id);
  };

  const handleStopRun = (jobId: string) => {
    wsClient.stopJob(jobId);
  };

  const handleInspectJobInWorkbench = (job: Job) => {
    setActiveJobId(job.id);
    setSpec(job.spec);
    setActiveTab('workbench');
    toast.info(`Switched active view to job: ${job.name}`);
  };

  const getStatusBadge = (status: Job['status']) => {
    switch (status) {
      case 'running':
        return (
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/40 font-semibold animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
            RUNNING
          </span>
        );
      case 'scheduled':
        return (
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#06B6D4]/15 text-[#06B6D4] border border-[#06B6D4]/40 font-semibold">
            <Calendar className="w-3 h-3" />
            SCHEDULED
          </span>
        );
      case 'error':
        return (
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/40 font-semibold">
            <AlertCircle className="w-3 h-3" />
            ERROR
          </span>
        );
      case 'paused':
        return (
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/40 font-semibold">
            PAUSED
          </span>
        );
      case 'idle':
      default:
        return (
          <span className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#18181b] text-gray-400 border border-[#383842] font-semibold">
            IDLE
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner & Header */}
      <div className="bg-[#242427] border border-[#383842] rounded-xl p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#06B6D4]/20 border border-[#06B6D4]/30 flex items-center justify-center">
            <Calendar className="w-5 h-5 text-[#06B6D4]" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <span>Multi-Job Management & Cron Scheduling</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#18181b] text-gray-300 border border-[#383842]">
                {jobs.length} Configured
              </span>
            </h2>
            <p className="text-xs text-gray-400">
              Configure autonomous periodic scouting tasks, timer schedules, and run pipelines
            </p>
          </div>
        </div>

        <button
          onClick={handleStartCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#059669] text-black font-semibold text-sm transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          <span>New Scheduled Job</span>
        </button>
      </div>

      {/* Creation Modal / Form Card */}
      {isCreating && (
        <form
          onSubmit={handleCreateSubmit}
          className="bg-[#242427] border border-[#06B6D4]/50 rounded-xl p-5 shadow-md flex flex-col gap-4 animate-in fade-in duration-150"
        >
          <div className="flex items-center justify-between border-b border-[#383842] pb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-[#06B6D4]" />
              <span>Configure New Job</span>
            </h3>
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">
                Job Name
              </label>
              <input
                type="text"
                value={newJobName}
                onChange={(e) => setNewJobName(e.target.value)}
                placeholder="e.g. HN AI Tools Scout"
                required
                className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#06B6D4]"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">
                Target URL
              </label>
              <input
                type="text"
                value={newJobTargetUrl}
                onChange={(e) => setNewJobTargetUrl(e.target.value)}
                placeholder="https://news.ycombinator.com"
                required
                className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-[#06B6D4]"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">
                Cron Schedule Expression / Interval
              </label>
              <input
                type="text"
                value={newJobCron}
                onChange={(e) => setNewJobCron(e.target.value)}
                placeholder="*/5 * * * * or @hourly"
                className="w-full bg-[#18181b] border border-[#383842] rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-[#06B6D4]"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Supports standard cron (5 parts), step intervals (*/5 * * * *), or @every 5m
              </p>
            </div>

            <div className="flex flex-col justify-center">
              <label className="text-xs text-gray-400 font-medium block mb-1">
                Schedule Activation
              </label>
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <input
                  type="checkbox"
                  checked={newJobIsScheduled}
                  onChange={(e) => setNewJobIsScheduled(e.target.checked)}
                  className="rounded bg-[#18181b] border-[#383842] text-[#06B6D4] focus:ring-0 w-4 h-4 cursor-pointer"
                />
                <span className="text-sm text-gray-200">
                  Enable automatic background scheduling
                </span>
              </label>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1">
              Natural Language Task Goal
            </label>
            <textarea
              value={newJobGoal}
              onChange={(e) => setNewJobGoal(e.target.value)}
              rows={2}
              placeholder="What should this job scout for?"
              className="w-full bg-[#18181b] border border-[#383842] rounded-lg p-2.5 text-sm text-gray-200 focus:outline-none focus:border-[#06B6D4] resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[#383842]">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="px-4 py-1.5 rounded-lg bg-[#18181b] border border-[#383842] text-sm text-gray-300 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg bg-[#10B981] hover:bg-[#059669] text-black font-semibold text-sm transition-colors"
            >
              Save Job
            </button>
          </div>
        </form>
      )}

      {/* Jobs List Grid */}
      <div className="grid grid-cols-1 gap-4">
        {jobs.length === 0 ? (
          <div className="bg-[#242427] border border-dashed border-[#383842] rounded-xl p-10 text-center flex flex-col items-center justify-center">
            <Calendar className="w-10 h-10 text-gray-500 mb-3" />
            <h3 className="text-base font-semibold text-white mb-1">No Jobs Configured</h3>
            <p className="text-sm text-gray-400 max-w-md mb-4">
              Create your first scheduled job to scout websites on a recurring cron timer or run batch evaluations.
            </p>
            <button
              onClick={handleStartCreate}
              className="px-4 py-2 bg-[#10B981] hover:bg-[#059669] text-black font-semibold text-sm rounded-lg transition-colors"
            >
              Create First Job
            </button>
          </div>
        ) : (
          jobs.map((job) => {
            const isEditing = editingJobId === job.id;
            const isCurrentActive = activeJobId === job.id;

            return (
              <div
                key={job.id}
                className={`bg-[#242427] border rounded-xl p-5 shadow-sm transition-colors ${
                  isCurrentActive ? 'border-[#06B6D4] ring-1 ring-[#06B6D4]/30' : 'border-[#383842] hover:border-[#4d4d5a]'
                }`}
              >
                {/* Header Row */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#383842] pb-3 mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-gray-400">{job.id}</span>
                    <h3 className="text-base font-semibold text-white">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editJobName}
                          onChange={(e) => setEditJobName(e.target.value)}
                          className="bg-[#18181b] border border-[#383842] rounded px-2 py-0.5 text-sm text-white"
                        />
                      ) : (
                        job.name
                      )}
                    </h3>
                    {getStatusBadge(job.status)}
                    {isCurrentActive && (
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#06B6D4]/20 text-[#06B6D4] border border-[#06B6D4]/30">
                        ACTIVE IN WORKBENCH
                      </span>
                    )}
                  </div>

                  {/* Actions Toolbar for Job */}
                  <div className="flex items-center gap-2">
                    {job.status === 'running' ? (
                      <button
                        onClick={() => handleStopRun(job.id)}
                        disabled={isStopping}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EF4444] hover:bg-[#dc2626] text-white text-xs font-semibold transition-colors disabled:opacity-50"
                      >
                        {isStopping ? (
                          <RotateCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Square className="w-3.5 h-3.5 fill-current" />
                        )}
                        <span>Stop</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleTriggerRun(job)}
                        disabled={isLaunching}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#10B981] hover:bg-[#059669] text-black text-xs font-semibold transition-colors disabled:opacity-50"
                      >
                        {isLaunching && isCurrentActive ? (
                          <RotateCw className="w-3.5 h-3.5 animate-spin text-black" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current" />
                        )}
                        <span>Run Now</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleInspectJobInWorkbench(job)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] text-xs text-gray-300 transition-colors"
                      title="Inspect Job in Workbench"
                    >
                      <Eye className="w-3.5 h-3.5 text-[#06B6D4]" />
                      <span>Workbench</span>
                    </button>

                    {isEditing ? (
                      <>
                        <button
                          onClick={() => handleSaveEdit(job.id)}
                          className="p-1.5 rounded bg-[#10B981]/20 text-[#10B981] hover:bg-[#10B981]/30 transition-colors"
                          title="Save Changes"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingJobId(null)}
                          className="p-1.5 rounded bg-gray-700/30 text-gray-400 hover:text-white transition-colors"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleStartEdit(job)}
                        className="p-1.5 rounded bg-[#18181b] border border-[#383842] hover:border-[#4d4d5a] text-gray-400 hover:text-white transition-colors"
                        title="Edit Schedule"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <button
                      onClick={() => handleDelete(job.id, job.name)}
                      className="p-1.5 rounded bg-[#EF4444]/15 border border-[#EF4444]/30 hover:bg-[#EF4444]/25 text-[#EF4444] transition-colors"
                      title="Delete Job"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Details Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  {/* Spec Info */}
                  <div className="bg-[#18181b] p-3 rounded-lg border border-[#383842] flex flex-col gap-1.5">
                    <span className="text-gray-400 font-medium flex items-center gap-1">
                      <ExternalLink className="w-3.5 h-3.5 text-[#06B6D4]" />
                      Target Endpoint
                    </span>
                    <span className="font-mono text-gray-200 truncate select-all">
                      {job.spec?.targetUrl || 'None'}
                    </span>
                    <span className="text-gray-500 font-mono text-[11px] truncate">
                      Selector: {job.spec?.domSelector || 'N/A'}
                    </span>
                  </div>

                  {/* Schedule Info */}
                  <div className="bg-[#18181b] p-3 rounded-lg border border-[#383842] flex flex-col gap-1.5">
                    <span className="text-gray-400 font-medium flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-[#8B5CF6]" />
                      Schedule & Cron
                    </span>
                    {isEditing ? (
                      <div className="flex flex-col gap-1">
                        <input
                          type="text"
                          value={editJobCron}
                          onChange={(e) => setEditJobCron(e.target.value)}
                          className="bg-[#242427] border border-[#383842] rounded px-2 py-0.5 text-xs font-mono text-white"
                        />
                        <label className="flex items-center gap-1.5 cursor-pointer mt-0.5">
                          <input
                            type="checkbox"
                            checked={editJobIsScheduled}
                            onChange={(e) => setEditJobIsScheduled(e.target.checked)}
                            className="rounded w-3.5 h-3.5"
                          />
                          <span className="text-[11px] text-gray-300">Scheduled</span>
                        </label>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-gray-200">
                          {job.cronSchedule || 'Manual Trigger Only'}
                        </span>
                        {job.isScheduled && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#06B6D4]/20 text-[#06B6D4] border border-[#06B6D4]/30">
                            ENABLED
                          </span>
                        )}
                      </div>
                    )}
                    <span className="text-gray-500 text-[11px]">
                      {job.nextRunAt
                        ? `Next run: ${new Date(job.nextRunAt).toLocaleString()}`
                        : 'No pending scheduled runs'}
                    </span>
                  </div>

                  {/* Execution History Info */}
                  <div className="bg-[#18181b] p-3 rounded-lg border border-[#383842] flex flex-col gap-1.5">
                    <span className="text-gray-400 font-medium flex items-center gap-1">
                      <Layers className="w-3.5 h-3.5 text-[#10B981]" />
                      Execution Trajectory
                    </span>
                    <span className="text-gray-300">
                      {job.lastRunAt
                        ? `Last executed: ${new Date(job.lastRunAt).toLocaleTimeString()}`
                        : 'Never executed yet'}
                    </span>
                    <span className="text-gray-500 text-[11px]">
                      Questions: {Object.keys(job.spec?.questions || {}).length} compiled rules
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
