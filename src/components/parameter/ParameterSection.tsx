import { RefreshCcw, Download, ChevronUp, ChevronDown } from 'lucide-react';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message, Parameter } from '@shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ParameterInput } from '@/components/parameter/ParameterInput';
import {
  validateParameterValue,
  isColorParameter,
} from '@/utils/parameterUtils';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import { downloadSTLFile, downloadOpenSCADFile } from '@/utils/downloadUtils';

interface ParameterSectionProps {
  parameters: Parameter[];
  onSubmit: (message: Message | null, parameters: Parameter[]) => void;
  currentOutput?: Blob;
}

export function ParameterSection({
  parameters,
  onSubmit,
  currentOutput,
}: ParameterSectionProps) {
  const { currentMessage } = useCurrentMessage();
  const [selectedFormat, setSelectedFormat] = useState<'stl' | 'scad'>('stl');

  // Split params into the main list (non-color, shown by default) and a
  // collapsible Colors group below it. Keeps the dimensions the user
  // usually wants front-and-center while colors stay one click away.
  const { mainParameters, colorParameters } = useMemo(() => {
    const main: Parameter[] = [];
    const color: Parameter[] = [];
    for (const p of parameters) {
      if (isColorParameter(p)) color.push(p);
      else main.push(p);
    }
    return { mainParameters: main, colorParameters: color };
  }, [parameters]);
  const [colorsOpen, setColorsOpen] = useState(true);
  const [dimensionsOpen, setDimensionsOpen] = useState(true);

  // Debounce timer for compilation
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingParametersRef = useRef<Parameter[] | null>(null);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Debounced submit function
  const debouncedSubmit = useCallback(
    (params: Parameter[]) => {
      // Store the parameters to submit
      pendingParametersRef.current = params;

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounced timer (200ms delay)
      debounceTimerRef.current = setTimeout(() => {
        if (pendingParametersRef.current) {
          onSubmit(currentMessage, pendingParametersRef.current);
          pendingParametersRef.current = null;
        }
      }, 200);
    },
    [onSubmit, currentMessage],
  );

  const handleCommit = (param: Parameter, value: Parameter['value']) => {
    const validatedValue = validateParameterValue(param, value);

    const updatedParam = { ...param, value: validatedValue };
    const updatedParameters = parameters.map((p) =>
      p.name === param.name ? updatedParam : p,
    );

    debouncedSubmit(updatedParameters);
  };

  const handleDownload = () => {
    if (selectedFormat === 'stl') {
      handleDownloadSTL();
    } else {
      handleDownloadOpenSCAD();
    }
  };

  const handleDownloadSTL = () => {
    if (!currentOutput) return;
    downloadSTLFile(currentOutput, currentMessage);
  };

  const handleDownloadOpenSCAD = () => {
    if (!currentMessage?.content.artifact?.code) return;
    downloadOpenSCADFile(currentMessage.content.artifact.code, currentMessage);
  };

  const isDownloadDisabled =
    selectedFormat === 'stl'
      ? !currentOutput
      : !currentMessage?.content.artifact?.code;

  return (
    <div className="h-full w-full max-w-full border-l border-gray-200/20 bg-adam-bg-secondary-dark dark:border-gray-800">
      <div className="flex h-14 items-center justify-between border-b border-adam-neutral-700 bg-gradient-to-r from-adam-bg-secondary-dark to-adam-bg-secondary-dark/95 px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight text-adam-text-primary">
            Parameters
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="h-8 w-8 rounded-full p-0 text-adam-text-primary transition-colors [@media(hover:hover)]:hover:bg-adam-neutral-950 [@media(hover:hover)]:hover:text-adam-neutral-10"
                disabled={parameters.length === 0}
                onClick={() => {
                  const newParameters = parameters.map((param) => ({
                    ...param,
                    value: param.defaultValue,
                  }));
                  onSubmit(currentMessage, newParameters);
                }}
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Reset all parameters</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex h-[calc(100%-3.5rem)] flex-col justify-between overflow-hidden">
        <ScrollArea className="flex-1 px-6 py-6">
          <div className="flex flex-col gap-3">
            {mainParameters.length > 0 && (
              <Collapsible
                open={dimensionsOpen}
                onOpenChange={setDimensionsOpen}
              >
                <CollapsibleTrigger
                  aria-label={`${dimensionsOpen ? 'Collapse' : 'Expand'} dimension parameters`}
                  className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs font-semibold text-adam-text-primary transition-colors focus:outline-none"
                >
                  <span className="flex items-center gap-2">
                    Dimensions
                    <span className="text-[10px] text-adam-neutral-400">
                      {mainParameters.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-adam-neutral-400 transition-all duration-200 group-hover:text-adam-text-primary ${
                      dimensionsOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
                  <div className="mt-3 flex flex-col gap-3">
                    {mainParameters.map((param) => (
                      <ParameterInput
                        key={param.name}
                        param={param}
                        handleCommit={handleCommit}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {colorParameters.length > 0 && (
              <Collapsible
                open={colorsOpen}
                onOpenChange={setColorsOpen}
                className="mt-3 border-t border-adam-neutral-700/60 pt-3"
              >
                <CollapsibleTrigger
                  aria-label={`${colorsOpen ? 'Collapse' : 'Expand'} color parameters`}
                  className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs font-semibold text-adam-text-primary transition-colors focus:outline-none"
                >
                  <span className="flex items-center gap-2">
                    Colors
                    <span className="text-[10px] text-adam-neutral-400">
                      {colorParameters.length}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-adam-neutral-400 transition-all duration-200 group-hover:text-adam-text-primary ${
                      colorsOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
                  <div className="mt-3 flex flex-col gap-3">
                    {colorParameters.map((param) => (
                      <ParameterInput
                        key={param.name}
                        param={param}
                        handleCommit={handleCommit}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-4 border-t border-adam-neutral-700 px-6 py-6">
          <div className="flex">
            <Button
              onClick={handleDownload}
              disabled={isDownloadDisabled}
              aria-label={`download ${selectedFormat.toUpperCase()} file`}
              className="h-12 flex-1 rounded-r-none bg-adam-neutral-50 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
            >
              <Download className="mr-2 h-4 w-4" />
              {selectedFormat.toUpperCase()}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  disabled={
                    !currentOutput && !currentMessage?.content.artifact?.code
                  }
                  aria-label="select download format"
                  className="h-12 w-12 rounded-l-none border-l border-adam-neutral-300 bg-adam-neutral-50 p-0 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64 border-none bg-adam-neutral-800 shadow-md"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('stl')}
                  disabled={!currentOutput}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.STL</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    3D Printing
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('scad')}
                  disabled={!currentMessage?.content.artifact?.code}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.SCAD</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    OpenSCAD Code
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
