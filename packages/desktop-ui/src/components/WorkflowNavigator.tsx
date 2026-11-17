import React, { useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Brain,
  Sliders,
  Play,
  CheckCircle2,
  FileText,
} from 'lucide-react';
import { useScoutStore, type WorkflowPage } from '../store/useScoutStore';

interface StepDefinition {
  step: WorkflowPage;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDefinition[] = [
  {
    step: 1,
    title: 'Goal & Model Setup',
    subtitle: 'System 2 Setup',
    icon: Brain,
  },
  {
    step: 2,
    title: 'Spec Inspector',
    subtitle: 'Task Plan & Threshold',
    icon: Sliders,
  },
  {
    step: 3,
    title: 'Live Execution',
    subtitle: 'Agent Snapshot & Inferences',
    icon: Play,
  },
  {
    step: 4,
    title: 'Results & Steering',
    subtitle: 'Findings & Chat Directives',
    icon: FileText,
  },
];

export const WorkflowNavigator: React.FC = () => {
  const currentPage = useScoutStore((state) => state.currentPage);
  const setPage = useScoutStore((state) => state.setPage);
  const nextPage = useScoutStore((state) => state.nextPage);
  const prevPage = useScoutStore((state) => state.prevPage);

  // Keyboard navigation: Alt + ArrowLeft (Prev), Alt + ArrowRight (Next)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        prevPage();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        nextPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prevPage, nextPage]);

  const prevStepDef = STEPS.find((s) => s.step === (currentPage - 1) as WorkflowPage);
  const nextStepDef = STEPS.find((s) => s.step === (currentPage + 1) as WorkflowPage);

  return (
    <div className="bg-[#1c1c20] border-b border-[#2d2d35] px-4 py-2.5 shadow-sm sticky top-[65px] z-20 backdrop-blur-md bg-[#1c1c20]/95">
      <div className="max-w-[1920px] w-full mx-auto px-2 sm:px-4 lg:px-8 xl:px-10 flex items-center justify-between gap-4">
        {/* Left Navigation Control */}
        <div className="flex items-center min-w-[140px]">
          <button
            onClick={prevPage}
            disabled={currentPage === 1}
            aria-label="Previous step"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[#383842] bg-[#242427] hover:bg-[#2c2c31] text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4 text-gray-300" />
            <span className="hidden sm:inline">
              {prevStepDef ? `Prev: Step ${prevStepDef.step}` : 'Previous'}
            </span>
            <span className="sm:hidden">Prev</span>
          </button>
        </div>

        {/* Center Step Indicator Bar */}
        <nav aria-label="Workflow progress" className="flex items-center justify-center flex-1 max-w-4xl px-2">
          <ol className="flex items-center w-full justify-between gap-2">
            {STEPS.map((stepDef, idx) => {
              const isActive = currentPage === stepDef.step;
              const isCompleted = currentPage > stepDef.step;
              const Icon = stepDef.icon;

              return (
                <li key={stepDef.step} className="flex items-center flex-1 last:flex-none">
                  <button
                    onClick={() => setPage(stepDef.step)}
                    className="group flex items-center gap-2.5 text-left focus:outline-none cursor-pointer"
                    aria-current={isActive ? 'step' : undefined}
                  >
                    {/* Badge */}
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all border shrink-0 ${
                        isActive
                          ? 'bg-[#8B5CF6] text-white border-[#8B5CF6] ring-2 ring-[#8B5CF6]/30 shadow-sm'
                          : isCompleted
                          ? 'bg-[#10B981]/20 text-[#10B981] border-[#10B981]/40 hover:bg-[#10B981]/30'
                          : 'bg-[#242427] text-gray-400 border-[#383842] group-hover:border-gray-500'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                      ) : (
                        <span>{stepDef.step}</span>
                      )}
                    </div>

                    {/* Step Title & Subtitle */}
                    <div className="hidden md:flex flex-col">
                      <span
                        className={`text-xs font-semibold leading-tight flex items-center gap-1 transition-colors ${
                          isActive
                            ? 'text-white'
                            : isCompleted
                            ? 'text-gray-200'
                            : 'text-gray-400 group-hover:text-gray-300'
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                        <span>{stepDef.title}</span>
                      </span>
                      <span className="text-[10px] text-gray-400 leading-tight">
                        {stepDef.subtitle}
                      </span>
                    </div>
                  </button>

                  {/* Connecting Line between steps */}
                  {idx < STEPS.length - 1 && (
                    <div
                      className={`flex-1 h-[2px] mx-3 transition-colors hidden sm:block ${
                        currentPage > stepDef.step
                          ? 'bg-[#10B981]/60'
                          : 'bg-[#2d2d35]'
                      }`}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Right Navigation Control */}
        <div className="flex items-center justify-end min-w-[140px]">
          <button
            onClick={nextPage}
            disabled={currentPage === 4}
            aria-label="Next step"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[#383842] bg-[#242427] hover:bg-[#2c2c31] text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="hidden sm:inline">
              {nextStepDef ? `Next: Step ${nextStepDef.step}` : 'Next'}
            </span>
            <span className="sm:hidden">Next</span>
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </button>
        </div>
      </div>
    </div>
  );
};
